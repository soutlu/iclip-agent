"""比较 Alembic head 与 iclip schema 的 ORM 表、列集合。

_MODULE_METADATA 必须包含所有自有表模块的元数据，确保迁移对账完整。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import MetaData, inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

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
    """0005：只有 path 没有 shot 的坐标清成 NULL，带 shot 的与本来就是 NULL 的不动。

    0012 随后把 path 从留下来的坐标里删掉，所以升到 head 之后带 shot 的那条只剩 `{"shot": 2}`。"""

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
    assert _jsonb(found[with_shot]) == {"shot": 2}
    assert found[none] is None


BEFORE_METADATA_PATH_DROP = "8d1c5f26ba34"
"""0011：坐标里还带着 path 的那一版。"""


async def test_path_drop_migration_keeps_the_other_coordinate_keys(migrated_pg: str) -> None:
    """0012：坐标里的 path 一律删掉，别的键原样留着；删完空了的置 NULL。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    video, frame_edit, gateway, video_edit, path_only = (uuid.uuid4() for _ in range(5))
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_METADATA_PATH_DROP)
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
                (video, '{"path": "video_shot.json", "shot": 2}'),
                (
                    frame_edit,
                    '{"path": "video_shot.json", "shot": 1, "frame": 3, '
                    '"sourceUrl": "https://cdn.test/a.png"}',
                ),
                # 只发 shot_index 的调用方与视频编辑链本来就没有 path。
                (gateway, '{"shot": 5}'),
                # 0013 会把 rootJob 抄进列再擦掉，这里只看 0012 留下了别的键。
                (
                    video_edit,
                    json.dumps({"rootJob": str(video), "baseJob": str(video), "editId": "e"}),
                ),
                # 0005 之后不该再有这种行；NULLIF 兜的就是它。
                (path_only, '{"path": "video_shot.json"}'),
            )
            for job_id, metadata in rows:
                await conn.execute(
                    text(
                        "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, provider, "
                        "request, status, metadata, created_at, updated_at) VALUES (:id, :owner, "
                        "'video', 'test', '{}', 'pending', CAST(:metadata AS jsonb), now(), now())"
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
                        {"ids": [video, frame_edit, gateway, video_edit, path_only]},
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

    assert _jsonb(found[video]) == {"shot": 2}
    assert _jsonb(found[frame_edit]) == {
        "shot": 1,
        "frame": 3,
        "sourceUrl": "https://cdn.test/a.png",
    }
    assert _jsonb(found[gateway]) == {"shot": 5}
    assert _jsonb(found[video_edit]) == {"baseJob": str(video), "editId": "e"}
    assert found[path_only] is None


BEFORE_ROOT_JOB = "5a9c2e17bd48"
"""0012：原作号还写在 metadata.rootJob 里的那一版。"""

_INSERT_GENERATION = text(
    "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, provider, request, status, "
    "metadata, created_at, updated_at) VALUES (:id, :owner, :kind, 'test', '{}', 'completed', "
    "CAST(:metadata AS jsonb), now(), now())"
)


async def _insert_generation_owner(conn: AsyncConnection, owner: uuid.UUID) -> None:
    await conn.execute(
        text(
            "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser, "
            "is_verified, display_name, avatar_url, roles, direct_permissions, city, "
            "job_title, departments) VALUES (:id, :email, 'x', true, false, true, '原作属主', "
            "'', '[]', '[]', '', '', '[]')"
        ),
        {"id": owner, "email": f"{owner}@example.com"},
    )


async def _remove_generation_owner(migrated_pg: str, owner: uuid.UUID) -> None:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text("DELETE FROM iclip.generation_jobs WHERE owner_user_id = :owner"),
                {"owner": owner},
            )
            await conn.execute(text("DELETE FROM iclip.users WHERE id = :owner"), {"owner": owner})
    finally:
        await engine.dispose()


async def test_root_job_migration_lifts_root_job_into_the_column(migrated_pg: str) -> None:
    """0013：便签上的 rootJob 抄进 root_job_id 再擦掉，别的键原样留着；降级再写回便签。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    root, reference, edited = (uuid.uuid4() for _ in range(3))
    chain = {"rootJob": str(root), "baseJob": str(root), "editId": "e"}
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_ROOT_JOB)
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            rows = (
                (root, "video", '{"shot": 2}'),
                (reference, "clip", json.dumps(chain)),
                (edited, "video", json.dumps({**chain, "editStart": 1})),
            )
            for job_id, kind, metadata in rows:
                await conn.execute(
                    _INSERT_GENERATION,
                    {"id": job_id, "owner": owner, "kind": kind, "metadata": metadata},
                )
        await engine.dispose()
        command.upgrade(cfg, "head")

        async with engine.connect() as conn:
            found = {
                row["id"]: (row["root_job_id"], _jsonb(row["metadata"]))
                for row in (
                    await conn.execute(
                        text(
                            "SELECT id, root_job_id, metadata FROM iclip.generation_jobs "
                            "WHERE owner_user_id = :owner"
                        ),
                        {"owner": owner},
                    )
                ).mappings()
            }
            foreign_keys = await conn.run_sync(
                lambda sync_conn: {
                    fk["name"]
                    for fk in inspect(sync_conn).get_foreign_keys(
                        "generation_jobs", schema=DB_SCHEMA
                    )
                }
            )
        await engine.dispose()
        command.downgrade(cfg, BEFORE_ROOT_JOB)
        async with engine.connect() as conn:
            restored = (
                await conn.execute(
                    text("SELECT metadata FROM iclip.generation_jobs WHERE id = :id"),
                    {"id": reference},
                )
            ).scalar_one()
    finally:
        await engine.dispose()
        command.upgrade(cfg, "head")
        await _remove_generation_owner(migrated_pg, owner)

    assert found[root] == (None, {"shot": 2}), "独立记录一个字不动"
    assert found[reference] == (root, {"baseJob": str(root), "editId": "e"})
    assert found[edited] == (root, {"baseJob": str(root), "editId": "e", "editStart": 1})
    assert "fk_generation_jobs_root_job" in foreign_keys
    assert _jsonb(restored) == chain, "降级把列写回便签"


async def _root_job_migration_refuses(
    migrated_pg: str, *, kind: str, metadata: str | None, message: str
) -> None:
    """0013 遇到对不上的行不静默放过：带 id 报错，库停在 0012。"""

    cfg = _alembic(migrated_pg)
    owner, job_id = uuid.uuid4(), uuid.uuid4()
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_ROOT_JOB)
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            await conn.execute(
                _INSERT_GENERATION,
                {"id": job_id, "owner": owner, "kind": kind, "metadata": metadata},
            )
        await engine.dispose()
        with pytest.raises(RuntimeError, match=message) as refused:
            command.upgrade(cfg, "head")
        async with engine.connect() as conn:
            version = (
                await conn.execute(text("SELECT version_num FROM iclip.alembic_version"))
            ).scalar_one()
    finally:
        await engine.dispose()
        await _remove_generation_owner(migrated_pg, owner)
        command.upgrade(cfg, "head")

    assert str(job_id) in str(refused.value), "报错要点名是哪一行"
    assert version == BEFORE_ROOT_JOB, "整个迁移回滚，列没加上"


async def test_root_job_migration_refuses_a_root_that_does_not_exist(migrated_pg: str) -> None:
    await _root_job_migration_refuses(
        migrated_pg,
        kind="video",
        metadata=json.dumps({"rootJob": str(uuid.uuid4())}),
        message="rootJob 指向不存在的记录",
    )


async def test_root_job_migration_refuses_a_clip_without_a_root(migrated_pg: str) -> None:
    await _root_job_migration_refuses(
        migrated_pg, kind="clip", metadata=None, message="clip 记录没有原作号"
    )


BEFORE_BASE_EDIT = "b6e2f4a9c713"
"""0013：编辑坐标里「基于哪一版」还写着记录 id（baseJob）的那一版。"""

_INSERT_CHAIN_JOB = text(
    "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, provider, request, status, "
    "metadata, root_job_id, created_at, updated_at) VALUES (:id, :owner, :kind, 'test', "
    "CAST(:request AS jsonb), 'completed', CAST(:metadata AS jsonb), :root, now(), now())"
)


async def _seed_chain(
    conn: AsyncConnection,
    owner: uuid.UUID,
    rows: Sequence[tuple[uuid.UUID, str, str, str | None, uuid.UUID | None]],
) -> None:
    """(id, kind, request, metadata, root_job_id) 各一行，都已完成。"""

    await _insert_generation_owner(conn, owner)
    for job_id, kind, request, metadata, root_id in rows:
        await conn.execute(
            _INSERT_CHAIN_JOB,
            {
                "id": job_id,
                "owner": owner,
                "kind": kind,
                "request": request,
                "metadata": metadata,
                "root": root_id,
            },
        )


async def _metadata_by_id(migrated_pg: str, owner: uuid.UUID) -> dict[uuid.UUID, object]:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        "SELECT id, metadata FROM iclip.generation_jobs WHERE owner_user_id = :owner"
                    ),
                    {"owner": owner},
                )
            ).mappings()
            return {row["id"]: _jsonb(row["metadata"]) for row in rows}
    finally:
        await engine.dispose()


async def test_base_edit_migration_rewrites_base_job_into_edit_ids(migrated_pg: str) -> None:
    """0014：baseJob 指向根的擦掉（基于原片不写），指向成片的换成那条成片的 editId；降级写回记录 id。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    root, master, reference, edited = (uuid.uuid4() for _ in range(4))
    # 第二轮编辑基于成片 e1：参考片段与编辑结果同一个 editId，baseJob 都写着成片的 id。
    second = {"baseJob": str(master), "editId": "e2", "editStart": 2, "editEnd": 5}
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_BASE_EDIT)
        async with engine.begin() as conn:
            await _seed_chain(
                conn,
                owner,
                (
                    (root, "video", '{"prompt": "p"}', '{"shot": 1}', None),
                    (
                        master,
                        "clip",
                        '{"purpose": "master", "segments": []}',
                        json.dumps(
                            {"baseJob": str(root), "editId": "e1", "editStart": 1, "editEnd": 4}
                        ),
                        root,
                    ),
                    (
                        reference,
                        "clip",
                        '{"purpose": "reference", "segments": []}',
                        json.dumps(second),
                        root,
                    ),
                    (edited, "video", '{"prompt": "p"}', json.dumps(second), root),
                ),
            )
        await engine.dispose()
        command.upgrade(cfg, "head")
        found = await _metadata_by_id(migrated_pg, owner)
        command.downgrade(cfg, BEFORE_BASE_EDIT)
        restored = await _metadata_by_id(migrated_pg, owner)
    finally:
        await engine.dispose()
        command.upgrade(cfg, "head")
        await _remove_generation_owner(migrated_pg, owner)

    upgraded_second = {"baseEdit": "e1", "editId": "e2", "editStart": 2, "editEnd": 5}
    assert found[root] == {"shot": 1}, "独立记录不动"
    assert found[master] == {"editId": "e1", "editStart": 1, "editEnd": 4}, "基于原片：键擦掉"
    assert found[reference] == upgraded_second
    assert found[edited] == upgraded_second
    assert restored[master] == {"baseJob": str(root), "editId": "e1", "editStart": 1, "editEnd": 4}
    assert restored[reference] == second
    assert restored[edited] == second


async def test_base_edit_migration_refuses_a_dangling_base_job(migrated_pg: str) -> None:
    """对不上的 baseJob 不能静默当成基于原片：带 id 报错，库停在 0013。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    root, edited = uuid.uuid4(), uuid.uuid4()
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_BASE_EDIT)
        async with engine.begin() as conn:
            await _seed_chain(
                conn,
                owner,
                (
                    (root, "video", '{"prompt": "p"}', '{"shot": 1}', None),
                    (
                        edited,
                        "video",
                        '{"prompt": "p"}',
                        json.dumps(
                            {
                                "baseJob": str(uuid.uuid4()),
                                "editId": "e2",
                                "editStart": 2,
                                "editEnd": 5,
                            }
                        ),
                        root,
                    ),
                ),
            )
        await engine.dispose()
        with pytest.raises(RuntimeError, match="baseJob 指向不存在的记录") as refused:
            command.upgrade(cfg, "head")
        async with engine.connect() as conn:
            version = (
                await conn.execute(text("SELECT version_num FROM iclip.alembic_version"))
            ).scalar_one()
    finally:
        await engine.dispose()
        await _remove_generation_owner(migrated_pg, owner)
        command.upgrade(cfg, "head")

    assert str(edited) in str(refused.value)
    assert version == BEFORE_BASE_EDIT


BEFORE_LAST_RUN_BACKFILL = "2d6f8a1b4c07"
"""0005：last_run_id 还没从运行映射回填的那一版。"""


async def test_last_run_backfill_takes_the_latest_run_and_keeps_later_renames(
    migrated_pg: str,
) -> None:
    """0006：活着的对话记下最近一次 run，过时的值也重算；updated_at 只往后推；没跑过的不动。

    0006 跳过的墓碑由 0007 用同一条规则补上，一起升到 head 后两边的值一样。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    ran_twice, renamed_after, never_ran, deleted = (uuid.uuid4() for _ in range(4))
    opened_at = datetime(2026, 9, 1, 8, 0, tzinfo=UTC)
    first_run_at = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)
    second_run_at = datetime(2026, 9, 3, 10, 0, tzinfo=UTC)
    renamed_at = datetime(2026, 9, 4, 11, 0, tzinfo=UTC)
    engine = create_async_engine(migrated_pg)
    try:
        await engine.dispose()
        command.downgrade(cfg, BEFORE_LAST_RUN_BACKFILL)
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser, "
                    "is_verified, display_name, avatar_url, roles, direct_permissions, city, "
                    "job_title, departments) VALUES (:id, :email, 'x', true, false, true, '回填属主', "
                    "'', '[]', '[]', '', '', '[]')"
                ),
                {"id": owner, "email": f"{owner}@example.com"},
            )
            conversations = (
                (ran_twice, opened_at, "backfill-stale", None),
                (renamed_after, renamed_at, None, None),
                (never_ran, opened_at, None, None),
                (deleted, opened_at, None, renamed_at),
            )
            for conversation_id, updated_at, last_run_id, deleted_at in conversations:
                await conn.execute(
                    text(
                        "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, "
                        "last_run_id, created_at, updated_at, deleted_at) VALUES (:id, :owner, "
                        "'storyboard', '一段', :last_run_id, :created_at, :updated_at, :deleted_at)"
                    ),
                    {
                        "id": conversation_id,
                        "owner": owner,
                        "last_run_id": last_run_id,
                        "created_at": opened_at,
                        "updated_at": updated_at,
                        "deleted_at": deleted_at,
                    },
                )
            runs = (
                (ran_twice, "backfill-p1", "backfill-r1", first_run_at),
                (ran_twice, "backfill-p2", "backfill-r2", second_run_at),
                (renamed_after, "backfill-p3", "backfill-r3", first_run_at),
                (deleted, "backfill-p4", "backfill-r4", first_run_at),
            )
            for conversation_id, prompt_id, run_id, started_at in runs:
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id, "
                        "owner_user_id, user_name, content, status, run_id, created_at, finished_at) "
                        "VALUES (:prompt_id, :conversation_id, 'storyboard', :owner, 'tester', '', "
                        "'done', :run_id, :started_at, :started_at)"
                    ),
                    {
                        "prompt_id": prompt_id,
                        "conversation_id": str(conversation_id),
                        "owner": owner,
                        "run_id": run_id,
                        "started_at": started_at,
                    },
                )
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.agent_job_runs (run_id, prompt_id, started_at) "
                        "VALUES (:run_id, :prompt_id, :started_at)"
                    ),
                    {"run_id": run_id, "prompt_id": prompt_id, "started_at": started_at},
                )
        await engine.dispose()
        command.upgrade(cfg, "head")

        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        "SELECT id, last_run_id, updated_at FROM iclip.conversations "
                        "WHERE owner_user_id = :owner"
                    ),
                    {"owner": owner},
                )
            ).mappings()
            by_id = {row["id"]: (row["last_run_id"], row["updated_at"]) for row in rows}
    finally:
        await engine.dispose()
        command.upgrade(cfg, "head")
        async with engine.begin() as conn:
            await conn.execute(
                text("DELETE FROM agent_runtime.agent_job_runs WHERE run_id LIKE 'backfill-%'")
            )
            await conn.execute(
                text("DELETE FROM agent_runtime.agent_jobs WHERE prompt_id LIKE 'backfill-%'")
            )
            await conn.execute(
                text("DELETE FROM iclip.conversations WHERE owner_user_id = :owner"),
                {"owner": owner},
            )
            await conn.execute(text("DELETE FROM iclip.users WHERE id = :owner"), {"owner": owner})
        await engine.dispose()

    assert by_id == {
        ran_twice: ("backfill-r2", second_run_at),
        renamed_after: ("backfill-r3", renamed_at),
        never_ran: (None, opened_at),
        deleted: ("backfill-r4", first_run_at),
    }
