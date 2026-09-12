"""比较 Alembic head 与 iclip schema 的 ORM 表、列集合。

_MODULE_METADATA 必须包含所有自有表模块的元数据，确保迁移对账完整。
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import MetaData, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.domains.collections.infra_sql import metadata_obj as collections_metadata
from iclip.domains.conversations.infra_sql import metadata_obj as conversations_metadata
from iclip.domains.generation.infra_sql import metadata_obj as generation_metadata
from iclip.domains.identity.infra_sql import DB_SCHEMA, Base
from iclip.domains.inspirations.infra_sql import metadata_obj as inspirations_metadata
from iclip.domains.tasks.infra_sql import metadata_obj as tasks_metadata

_MODULE_METADATA: tuple[MetaData, ...] = (
    Base.metadata,
    conversations_metadata,
    generation_metadata,
    collections_metadata,
    tasks_metadata,
    inspirations_metadata,
)


async def test_alembic_head_matches_orm_metadata(migrated_pg: str) -> None:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            actual: dict[str, set[str]] = await conn.run_sync(
                lambda sync_conn: {
                    table: {
                        column["name"]
                        for column in inspect(sync_conn).get_columns(table, schema=DB_SCHEMA)
                    }
                    for table in inspect(sync_conn).get_table_names(schema=DB_SCHEMA)
                    if table != "alembic_version"
                }
            )
    finally:
        await engine.dispose()

    expected = {
        table.name: {column.name for column in table.columns}
        for metadata in _MODULE_METADATA
        for table in metadata.tables.values()
    }
    assert actual == expected


def _alembic(url: str) -> AlembicConfig:
    server_dir = Path(__file__).resolve().parents[3]
    cfg = AlembicConfig(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    cfg.attributes["sqlalchemy_url"] = url
    return cfg


def test_upgrade_is_idempotent_at_head(migrated_pg: str) -> None:
    command.upgrade(_alembic(migrated_pg), "head")


BEFORE_SOFT_DELETE = "8b1f4a2c9d3e"
"""0002：对话还是物理删除、id 记在 conversation_ids 里的那一版。"""


async def test_soft_delete_migration_rebuilds_tombstones_from_agent_jobs(migrated_pg: str) -> None:
    """0003 的回填：有票据的墓碑补成已删对话行，没票据的与属主不在的丢，活着的对话不动。"""

    cfg = _alembic(migrated_pg)
    owner, stranger = uuid.uuid4(), uuid.uuid4()
    with_jobs, without_jobs, orphan, alive = (uuid.uuid4() for _ in range(4))
    first_at = datetime(2026, 9, 1, 8, 0, tzinfo=UTC)
    last_at = datetime(2026, 9, 2, 9, 30, tzinfo=UTC)
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_SOFT_DELETE)
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser, "
                    "is_verified, display_name, avatar_url, roles, direct_permissions, city, "
                    "job_title, departments) VALUES (:id, :email, 'x', true, false, true, '墓碑属主', "
                    "'', '[]', '[]', '', '', '[]')"
                ),
                {"id": owner, "email": f"{owner}@example.com"},
            )
            await conn.execute(
                text("INSERT INTO iclip.conversation_ids (id) VALUES (:a), (:b), (:c), (:d)"),
                {"a": with_jobs, "b": without_jobs, "c": orphan, "d": alive},
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, "
                    "created_at, updated_at) VALUES (:id, :owner, 'storyboard', '还活着', now(), now())"
                ),
                {"id": alive, "owner": owner},
            )
            jobs = (
                (with_jobs, owner, "storyboard", first_at, None),
                (with_jobs, owner, "renamed-later", last_at, last_at),
                (orphan, stranger, "storyboard", first_at, first_at),
            )
            for conversation_id, job_owner, agent_id, created_at, finished_at in jobs:
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id, "
                        "owner_user_id, user_name, content, status, created_at, finished_at) VALUES "
                        "(:prompt_id, :conversation_id, :agent_id, :owner, 'tester', '', 'done', "
                        ":created_at, :finished_at)"
                    ),
                    {
                        "prompt_id": f"tombstone-{uuid.uuid4().hex}",
                        "conversation_id": str(conversation_id),
                        "agent_id": agent_id,
                        "owner": job_owner,
                        "created_at": created_at,
                        "finished_at": finished_at,
                    },
                )
        await engine.dispose()
        command.upgrade(cfg, "head")

        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        "SELECT id, owner_user_id, agent_id, created_at, updated_at, deleted_at "
                        "FROM iclip.conversations WHERE id = ANY(:ids)"
                    ),
                    {"ids": [with_jobs, without_jobs, orphan, alive]},
                )
            ).mappings()
            by_id = {row["id"]: row for row in rows}
            registry = await conn.run_sync(
                lambda sync_conn: inspect(sync_conn).has_table("conversation_ids", schema=DB_SCHEMA)
            )
    finally:
        await engine.dispose()
        command.upgrade(cfg, "head")
        async with engine.begin() as conn:
            await conn.execute(
                text("DELETE FROM agent_runtime.agent_jobs WHERE prompt_id LIKE 'tombstone-%'")
            )
            await conn.execute(
                text("DELETE FROM iclip.conversations WHERE owner_user_id = :owner"),
                {"owner": owner},
            )
            await conn.execute(text("DELETE FROM iclip.users WHERE id = :owner"), {"owner": owner})
        await engine.dispose()

    assert set(by_id) == {with_jobs, alive}
    tombstone = by_id[with_jobs]
    assert (tombstone["owner_user_id"], tombstone["agent_id"]) == (owner, "storyboard")
    assert (tombstone["created_at"], tombstone["updated_at"]) == (first_at, last_at)
    assert tombstone["deleted_at"] is not None
    assert by_id[alive]["deleted_at"] is None
    assert registry is False


BEFORE_UPLOADS = "4c7d9e1f2a68"
"""0003：权限还叫 assets:*、media_assets 还在的那一版。"""


def _permissions(value: object) -> list[str]:
    """JSONB 经 text() 查询回来可能是已解码的列表，也可能是原文。"""

    return list(json.loads(value) if isinstance(value, str) else value)  # type: ignore[arg-type]


def _jsonb(value: object) -> object:
    """同上，任意形状的 JSONB。"""

    return json.loads(value) if isinstance(value, str) else value


async def test_uploads_migration_renames_permissions_and_drops_the_registry(
    migrated_pg: str,
) -> None:
    """0004：两个 JSONB 数组里的旧权限名改成新名，别的权限不动；media_assets 没了。"""

    cfg = _alembic(migrated_pg)
    owner, key_id = uuid.uuid4(), uuid.uuid4()
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_UPLOADS)
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser, "
                    "is_verified, display_name, avatar_url, roles, direct_permissions, city, "
                    "job_title, departments) VALUES (:id, :email, 'x', true, false, true, '改名属主', "
                    "'', '[]', '[\"assets:read\", \"tasks:read\"]', '', '', '[]')"
                ),
                {"id": owner, "email": f"{owner}@example.com"},
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.api_keys (id, owner_user_id, name, token_hash, token_prefix, "
                    "permissions) VALUES (:id, :owner, 'ci', :hash, 'ick_test', "
                    '\'["assets:write", "assets:read"]\')'
                ),
                {"id": key_id, "owner": owner, "hash": uuid.uuid4().hex},
            )
        await engine.dispose()
        command.upgrade(cfg, "head")

        async with engine.connect() as conn:
            direct = (
                await conn.execute(
                    text("SELECT direct_permissions FROM iclip.users WHERE id = :id"), {"id": owner}
                )
            ).scalar_one()
            granted = (
                await conn.execute(
                    text("SELECT permissions FROM iclip.api_keys WHERE id = :id"), {"id": key_id}
                )
            ).scalar_one()
            registry = await conn.run_sync(
                lambda sync_conn: inspect(sync_conn).has_table("media_assets", schema=DB_SCHEMA)
            )
    finally:
        await engine.dispose()
        command.upgrade(cfg, "head")
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM iclip.api_keys WHERE id = :id"), {"id": key_id})
            await conn.execute(text("DELETE FROM iclip.users WHERE id = :id"), {"id": owner})
        await engine.dispose()

    assert sorted(_permissions(direct)) == ["inspirations:read", "tasks:read"]
    assert sorted(_permissions(granted)) == ["inspirations:read", "uploads:write"]
    assert registry is False


BEFORE_METADATA_CLEANUP = "9e3a7c5b2d41"
"""0004：0002 误回填的只有 path 的坐标还在的那一版。"""


async def test_metadata_cleanup_migration_nulls_path_only_coordinates(migrated_pg: str) -> None:
    """0005：只有 path 没有 shot 的坐标清成 NULL，带 shot 的与本来就是 NULL 的不动。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    path_only, with_shot, none = (uuid.uuid4() for _ in range(3))
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_METADATA_CLEANUP)
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser, "
                    "is_verified, display_name, avatar_url, roles, direct_permissions, city, "
                    "job_title, departments) VALUES (:id, :email, 'x', true, false, true, '清理属主', "
                    "'', '[]', '[]', '', '', '[]')"
                ),
                {"id": owner, "email": f"{owner}@example.com"},
            )
            rows = (
                (path_only, '{"path": "video_shot.json"}'),
                (with_shot, '{"path": "video_shot.json", "shot": 2}'),
                (none, None),
            )
            for job_id, metadata in rows:
                await conn.execute(
                    text(
                        "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, provider, "
                        "request, status, metadata, created_at, updated_at) VALUES (:id, :owner, "
                        "'image', 'test', '{}', 'pending', CAST(:metadata AS jsonb), now(), now())"
                    ),
                    {"id": job_id, "owner": owner, "metadata": metadata},
                )
        await engine.dispose()
        command.upgrade(cfg, "head")

        async with engine.connect() as conn:
            found = {
                row["id"]: row["metadata"]
                for row in (
                    await conn.execute(
                        text(
                            "SELECT id, metadata FROM iclip.generation_jobs "
                            "WHERE id = ANY(CAST(:ids AS uuid[]))"
                        ),
                        {"ids": [path_only, with_shot, none]},
                    )
                ).mappings()
            }
    finally:
        await engine.dispose()
        command.upgrade(cfg, "head")
        async with engine.begin() as conn:
            await conn.execute(
                text("DELETE FROM iclip.generation_jobs WHERE owner_user_id = :owner"),
                {"owner": owner},
            )
            await conn.execute(text("DELETE FROM iclip.users WHERE id = :owner"), {"owner": owner})
        await engine.dispose()

    assert found[path_only] is None
    assert _jsonb(found[with_shot]) == {"path": "video_shot.json", "shot": 2}
    assert found[none] is None
