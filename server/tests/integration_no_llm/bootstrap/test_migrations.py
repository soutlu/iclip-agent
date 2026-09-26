"""比较 Alembic head 与 iclip schema 的 ORM 表、列集合。

_MODULE_METADATA 必须包含所有自有表模块的元数据，确保迁移对账完整。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi_users.password import PasswordHelper
from sqlalchemy import MetaData, inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from iclip.domains.collections.infra_sql import metadata_obj as collections_metadata
from iclip.domains.conversations.infra_sql import metadata_obj as conversations_metadata
from iclip.domains.generation.infra_sql import metadata_obj as generation_metadata
from iclip.domains.identity.acting import placeholder_email
from iclip.domains.identity.infra_sql import DB_SCHEMA, Base
from iclip.domains.inspirations.infra_sql import metadata_obj as inspirations_metadata
from iclip.domains.tasks.infra_sql import metadata_obj as tasks_metadata
from iclip.domains.tracking.infra_sql import metadata_obj as tracking_metadata
from tests.helpers.pg import reset_database

_MODULE_METADATA: tuple[MetaData, ...] = (
    Base.metadata,
    conversations_metadata,
    generation_metadata,
    collections_metadata,
    tasks_metadata,
    inspirations_metadata,
    tracking_metadata,
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


@pytest.fixture(autouse=True)
async def _start_from_empty_tables(migrated_pg: str) -> None:
    """降级会按行核对（0017 有取到结尾的合成就拒绝），别的用例留下的行不能左右这里的结果。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await reset_database(conn)
    finally:
        await engine.dispose()


def test_upgrade_is_idempotent_at_head(migrated_pg: str) -> None:
    command.upgrade(_alembic(migrated_pg), "head")


BEFORE_OPERATION = "2f9ffd7b9bbe"
"""0016：记录上还没有 operation / 来源 / 区间、编辑坐标还写在 metadata 里的那一版。

更早迁移的用例升到这里为止：它们种的编辑链只为验那一版，过不了 0017 的核对。"""


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
        command.upgrade(cfg, BEFORE_OPERATION)

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
        await _remove_generation_owner(migrated_pg, owner)
        command.upgrade(cfg, "head")

    assert _jsonb(found[video]) == {"shot": 2}
    assert _jsonb(found[frame_edit]) == {
        "shot": 1,
        "frame": 3,
        "sourceUrl": "https://cdn.test/a.png",
    }
    assert _jsonb(found[gateway]) == {"shot": 5}
    # 升到 0016 还会过 0013 与 0014：rootJob 抄进列，指向根的 baseJob 擦掉，只剩 editId。
    assert _jsonb(found[video_edit]) == {"editId": "e"}
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
        command.upgrade(cfg, BEFORE_OPERATION)

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
        await _remove_generation_owner(migrated_pg, owner)
        command.upgrade(cfg, "head")

    assert found[root] == (None, {"shot": 2}), "独立记录一个字不动"
    # 升到 0016 还会过 0014：指向根的 baseJob 是「基于原片」，键擦掉。
    assert found[reference] == (root, {"editId": "e"})
    assert found[edited] == (root, {"editId": "e", "editStart": 1})
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
        command.upgrade(cfg, BEFORE_OPERATION)
        found = await _metadata_by_id(migrated_pg, owner)
        command.downgrade(cfg, BEFORE_BASE_EDIT)
        restored = await _metadata_by_id(migrated_pg, owner)
    finally:
        await engine.dispose()
        await _remove_generation_owner(migrated_pg, owner)
        command.upgrade(cfg, "head")

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
            command.upgrade(cfg, BEFORE_OPERATION)
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


BEFORE_FORK_INHERIT = "44301a1420de"
"""0015：分叉还把出片记录拷进副本的那一版。"""

_INSERT_FORK_CONVERSATION = text(
    "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at, updated_at, "
    "forked_from, fork_turn) VALUES (:id, :owner, 'storyboard', 't', :at, :at, :parent, :turn)"
)
_INSERT_FORK_JOB = text(
    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind, provider, "
    "request, status, root_job_id, output_url, created_at, updated_at, finished_at) VALUES "
    "(:id, :owner, :conversation, :kind, 'test', CAST(:request AS jsonb), 'completed', :root, "
    ":url, :at, :at, :at)"
)
_INSERT_DOWNLOAD = text(
    "INSERT INTO iclip.tracking_events (id, name, job_id, user_id, occurred_at) "
    "VALUES (:id, 'video.downloaded', :job, :owner, now())"
)
_REQUESTS = {
    "video": '{"prompt": "p"}',
    "master": '{"purpose": "master", "segments": []}',
    "reference": '{"purpose": "reference", "segments": []}',
}


def _minute(n: int) -> datetime:
    return datetime(2026, 9, 1, tzinfo=UTC) + timedelta(minutes=n)


async def _seed_forks(
    migrated_pg: str,
    owner: uuid.UUID,
    *,
    conversations: Sequence[tuple[uuid.UUID, uuid.UUID | None, int]],
    jobs: Sequence[tuple[uuid.UUID, uuid.UUID, str, uuid.UUID | None, str, int]],
    downloads: Sequence[tuple[uuid.UUID, uuid.UUID]] = (),
) -> None:
    """对话 (id, 来源, 建立分钟)、记录 (id, 对话, 请求种类, 原作号, 地址名, 建立分钟)、下载 (id, 记录)。

    清掉别的用例留下的行：认副本看的是全表，遗留的分叉数据会让迁移在别人的行上报错。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await reset_database(conn)
            await _insert_generation_owner(conn, owner)
            for conversation_id, parent, minute in conversations:
                await conn.execute(
                    _INSERT_FORK_CONVERSATION,
                    {
                        "id": conversation_id,
                        "owner": owner,
                        "at": _minute(minute),
                        "parent": parent,
                        "turn": None if parent is None else 1,
                    },
                )
            for job_id, conversation_id, request, root, name, minute in jobs:
                await conn.execute(
                    _INSERT_FORK_JOB,
                    {
                        "id": job_id,
                        "owner": owner,
                        "conversation": conversation_id,
                        "kind": "video" if request == "video" else "clip",
                        "request": _REQUESTS[request],
                        "root": root,
                        "url": f"https://example.test/{name}.mp4",
                        "at": _minute(minute),
                    },
                )
            for event_id, job_id in downloads:
                await conn.execute(
                    _INSERT_DOWNLOAD, {"id": event_id, "job": job_id, "owner": owner}
                )
    finally:
        await engine.dispose()


async def _clear(migrated_pg: str) -> None:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await reset_database(conn)
    finally:
        await engine.dispose()


async def test_fork_inherit_migration_folds_copies_back_into_their_sources(
    migrated_pg: str,
) -> None:
    """0016：副本里拷来的记录删掉；副本里原生的成片改指源那条原作，指向拷贝的下载事件并回源记录。

    嵌套分叉：孙对话里的拷贝是父对话里拷贝的拷贝，源要一路找到祖父那条非拷贝的。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    grand, parent, child = (uuid.uuid4() for _ in range(3))
    take, master, reference = (uuid.uuid4() for _ in range(3))
    take_1, master_1, parent_master, parent_take = (uuid.uuid4() for _ in range(4))
    take_2, master_2, parent_master_2, parent_take_2, child_master = (
        uuid.uuid4() for _ in range(5)
    )
    on_copy, on_nested, on_parent_copy, on_native = (uuid.uuid4() for _ in range(4))
    try:
        command.downgrade(cfg, BEFORE_FORK_INHERIT)
        await _seed_forks(
            migrated_pg,
            owner,
            conversations=((grand, None, 0), (parent, grand, 10), (child, parent, 20)),
            jobs=(
                (take, grand, "video", None, "take", 1),
                (master, grand, "master", take, "master", 2),
                (reference, grand, "reference", take, "reference", 3),
                # 父对话：拷来的一对（时间戳是源的），加上分叉后剪的成片与新出的片。
                (take_1, parent, "video", None, "take", 1),
                (master_1, parent, "master", take_1, "master", 2),
                (parent_master, parent, "master", take_1, "parent-master", 12),
                (parent_take, parent, "video", None, "parent-take", 13),
                # 孙对话：父对话里四条的拷贝（拷贝的拷贝指向孙对话里的新根），加上自己剪的成片。
                (take_2, child, "video", None, "take", 1),
                (master_2, child, "master", take_2, "master", 2),
                (parent_master_2, child, "master", take_2, "parent-master", 12),
                (parent_take_2, child, "video", None, "parent-take", 13),
                (child_master, child, "master", take_2, "child-master", 21),
            ),
            downloads=(
                (on_copy, take_1),
                (on_nested, master_2),
                (on_parent_copy, parent_master_2),
                (on_native, parent_take),
            ),
        )
        command.upgrade(cfg, BEFORE_OPERATION)
        engine = create_async_engine(migrated_pg)
        try:
            async with engine.connect() as conn:
                jobs = await conn.execute(
                    text(
                        "SELECT id, root_job_id FROM iclip.generation_jobs "
                        "WHERE owner_user_id = :owner"
                    ),
                    {"owner": owner},
                )
                roots = {job_id: root for job_id, root in jobs.all()}
                events = await conn.execute(
                    text("SELECT id, job_id FROM iclip.tracking_events WHERE user_id = :u"),
                    {"u": owner},
                )
                downloaded = {event_id: job_id for event_id, job_id in events.all()}
        finally:
            await engine.dispose()
    finally:
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert roots == {
        take: None,
        master: take,
        reference: take,
        parent_master: take,
        parent_take: None,
        child_master: take,
    }, "拷贝全删，留下的衍生记录都指祖父那条原作"
    assert downloaded == {
        on_copy: take,
        on_nested: master,
        on_parent_copy: parent_master,
        on_native: parent_take,
    }, "下载事件并回源记录；本来就指非拷贝的不动"


@pytest.mark.parametrize("sources", [0, 2], ids=["找不到源", "源不唯一"])
async def test_fork_inherit_migration_refuses_a_copy_without_exactly_one_source(
    migrated_pg: str, sources: int
) -> None:
    """拷贝对不上唯一一条源记录时不静默删掉或留着：带 id 报错，库停在 0015。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    source, fork, copy = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    originals = tuple(
        (uuid.uuid4(), source, "video", None, "take", 1 + index) for index in range(sources)
    )
    try:
        command.downgrade(cfg, BEFORE_FORK_INHERIT)
        await _seed_forks(
            migrated_pg,
            owner,
            conversations=((source, None, 0), (fork, source, 10)),
            jobs=(*originals, (copy, fork, "video", None, "take", 1)),
        )
        with pytest.raises(RuntimeError, match="找不到唯一一条源记录") as refused:
            command.upgrade(cfg, BEFORE_OPERATION)
        engine = create_async_engine(migrated_pg)
        try:
            async with engine.connect() as conn:
                version = (
                    await conn.execute(text("SELECT version_num FROM iclip.alembic_version"))
                ).scalar_one()
        finally:
            await engine.dispose()
    finally:
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert str(copy) in str(refused.value), "报错要点名是哪一行"
    assert version == BEFORE_FORK_INHERIT


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


OPERATION = "7c50c7336e0c"
"""0017：记录上有了 operation、来源与区间，参考片段不再落行的那一版。

它的用例升到这里为止：0018 会把视频的镜号从 metadata 搬走。"""

SHOT_INDEX = "3403faebf6dc"
"""0018：视频的镜号与合成的时长各落一列，视频的 metadata 里不再有 shot 的那一版。"""

OWNER_FIX = "69f785644eb5"
"""0019：早期钥匙行的属主校正成请求里指名的那个人的那一版。"""

IMAGE_SOURCE = "fd0a5be42793"
"""0020：图片记来源，上传与切图各落一行的那一版。"""

_INSERT_BEFORE_OPERATION = text(
    "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, provider, request, status, "
    "metadata, root_job_id, output_url, created_at, updated_at, finished_at) VALUES (:id, :owner, "
    ":kind, 'test', CAST(:request AS jsonb), :status, CAST(:metadata AS jsonb), :root, :url, :at, "
    ":at, :at)"
)
_MASTER_SEGMENTS: list[dict[str, object]] = [
    {"url": "https://example.test/root.mp4", "start": 0, "end": 0.834},
    {"url": "https://example.test/edit.mp4", "start": 0, "end": 3.3},
    {"url": "https://example.test/root.mp4", "start": 4, "end": 6},
]
_MASTER_REQUEST: dict[str, object] = {"purpose": "master", "segments": _MASTER_SEGMENTS}

_ChainRow = tuple[
    uuid.UUID, str, Mapping[str, object], Mapping[str, object] | None, uuid.UUID | None, int
]
"""(id, kind, request, metadata, 原作号, 建立分钟)；状态除非另给都是已完成。"""


async def _seed_before_operation(
    migrated_pg: str,
    owner: uuid.UUID,
    rows: Sequence[_ChainRow],
    *,
    failed: frozenset[uuid.UUID] = frozenset(),
) -> None:
    """在 0016 的表上种一条编辑链；建立、完成时刻按分钟错开，``failed`` 里的记成失败。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            for job_id, kind, request, metadata, root, minute in rows:
                done = job_id not in failed
                await conn.execute(
                    _INSERT_BEFORE_OPERATION,
                    {
                        "id": job_id,
                        "owner": owner,
                        "kind": kind,
                        "request": json.dumps(request),
                        "status": "completed" if done else "failed",
                        "metadata": None if metadata is None else json.dumps(metadata),
                        "root": root,
                        "url": f"https://example.test/{job_id}.mp4" if done else None,
                        "at": _minute(minute),
                    },
                )
    finally:
        await engine.dispose()


async def _select_rows(
    migrated_pg: str, owner: uuid.UUID, columns: str
) -> dict[uuid.UUID, dict[str, object]]:
    """这个属主名下每行的几列；``columns`` 是用例里的常量列名。JSONB 列解码成对象。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        f"SELECT id, {columns} FROM iclip.generation_jobs "
                        "WHERE owner_user_id = :owner"
                    ),
                    {"owner": owner},
                )
            ).mappings()
            return {
                row["id"]: {
                    key: _jsonb(value)
                    if key in ("request", "metadata", "provider_snapshot")
                    else value
                    for key, value in row.items()
                    if key != "id"
                }
                for row in rows
            }
    finally:
        await engine.dispose()


async def _alembic_version(migrated_pg: str) -> str:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(text("SELECT version_num FROM iclip.alembic_version"))
            ).scalar_one()
    finally:
        await engine.dispose()


async def _generation_shape(migrated_pg: str) -> dict[str, set[str]]:
    """生成表上的约束、外键与索引名，以及不可空的列。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            return await conn.run_sync(
                lambda sync_conn: {
                    "checks": {
                        str(item["name"])
                        for item in inspect(sync_conn).get_check_constraints(
                            "generation_jobs", schema=DB_SCHEMA
                        )
                    },
                    "foreign_keys": {
                        str(item["name"])
                        for item in inspect(sync_conn).get_foreign_keys(
                            "generation_jobs", schema=DB_SCHEMA
                        )
                    },
                    "indexes": {
                        str(item["name"])
                        for item in inspect(sync_conn).get_indexes(
                            "generation_jobs", schema=DB_SCHEMA
                        )
                    },
                    "not_null": {
                        str(item["name"])
                        for item in inspect(sync_conn).get_columns(
                            "generation_jobs", schema=DB_SCHEMA
                        )
                        if not item["nullable"]
                    },
                }
            )
    finally:
        await engine.dispose()


async def test_operation_migration_backfills_sources_and_ranges_and_drops_reference_clips(
    migrated_pg: str,
) -> None:
    """0017：参考片段删掉；成片改记 video / compose、request 去掉 purpose；编辑结果的来源按 baseEdit
    找最后完成的那次成片、没有就是原作，区间四舍五入成毫秒；成片的来源是它之前那条编辑结果；
    四个坐标键擦掉，编辑结果的 request 不动。降级再按编辑段 id 重建坐标，两轮编辑互相对得上。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    root, reference, edit_1, master_1, recomposed_1, edit_2, master_2, image = (
        uuid.uuid4() for _ in range(8)
    )
    first: dict[str, object] = {"editId": "e1", "editStart": 0.8335, "editEnd": 4}
    second: dict[str, object] = {"baseEdit": "e1", "editId": "e2", "editStart": 2, "editEnd": 5}
    edit_request: dict[str, object] = {
        "prompt": "p",
        "reference_video_urls": ["https://example.test/reference.mp4"],
    }
    reference_request: dict[str, object] = {
        "purpose": "reference",
        "segments": [{"url": "https://example.test/root.mp4", "start": 1, "end": 4}],
    }
    try:
        command.downgrade(cfg, BEFORE_OPERATION)
        await _seed_before_operation(
            migrated_pg,
            owner,
            (
                (root, "video", {"prompt": "p"}, {"shot": 1}, None, 0),
                (reference, "clip", reference_request, first, root, 1),
                (edit_1, "video", edit_request, first, root, 2),
                (master_1, "clip", _MASTER_REQUEST, first, root, 3),
                # 同一次编辑重新合成过：基于它的下一轮编辑取最后完成的那条。
                (recomposed_1, "clip", _MASTER_REQUEST, first, root, 4),
                (edit_2, "video", {"prompt": "p2"}, second, root, 5),
                (master_2, "clip", _MASTER_REQUEST, second, root, 6),
                (image, "image", {"prompt": "猫"}, {"shot": 1, "frame": 2}, None, 7),
            ),
        )
        command.upgrade(cfg, OPERATION)
        upgraded = await _select_rows(
            migrated_pg,
            owner,
            "kind, operation, source_job_id, root_job_id, range_start_ms, range_end_ms, "
            "request, metadata",
        )
        shape = await _generation_shape(migrated_pg)
        command.downgrade(cfg, BEFORE_OPERATION)
        restored = await _select_rows(migrated_pg, owner, "kind, request, metadata")
    finally:
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    roles = {
        job_id: (
            row["kind"],
            row["operation"],
            row["source_job_id"],
            row["range_start_ms"],
            row["range_end_ms"],
            row["metadata"],
        )
        for job_id, row in upgraded.items()
    }
    assert roles == {
        root: ("video", "generate", None, None, None, {"shot": 1}),
        edit_1: ("video", "generate", root, 834, 4000, None),
        master_1: ("video", "compose", edit_1, None, None, None),
        recomposed_1: ("video", "compose", edit_1, None, None, None),
        edit_2: ("video", "generate", recomposed_1, 2000, 5000, None),
        master_2: ("video", "compose", edit_2, None, None, None),
        image: ("image", "generate", None, None, None, {"shot": 1, "frame": 2}),
    }, "参考片段整行删掉，其余各就各位"
    assert {job_id for job_id, row in upgraded.items() if row["root_job_id"] == root} == {
        edit_1,
        master_1,
        recomposed_1,
        edit_2,
        master_2,
    }
    assert upgraded[edit_1]["request"] == edit_request, "编辑结果的 request 是历史，不改写"
    assert upgraded[master_1]["request"] == {"segments": _MASTER_SEGMENTS}, "purpose 去掉"
    assert {
        "ck_generation_jobs_kind",
        "ck_generation_jobs_operation",
        "ck_generation_jobs_video_shape",
        "ck_generation_jobs_image_shape",
    } <= shape["checks"]
    assert "fk_generation_jobs_source_job" in shape["foreign_keys"]
    assert "ix_generation_jobs_source_job" in shape["indexes"]
    assert "operation" in shape["not_null"]

    first_back = {"editId": str(edit_1), "editStart": 0.834, "editEnd": 4}
    second_back = {"editId": str(edit_2), "editStart": 2, "editEnd": 5, "baseEdit": str(edit_1)}
    assert set(restored) == set(upgraded), "参考片段降级不造回"
    assert restored[edit_1]["metadata"] == first_back
    assert restored[edit_2]["metadata"] == second_back, "baseEdit 与它基于的那次成片的 editId 相同"
    for master in (master_1, recomposed_1):
        assert restored[master] == {
            "kind": "clip",
            "request": _MASTER_REQUEST,
            "metadata": first_back,
        }
    assert restored[master_2]["metadata"] == second_back
    assert restored[root]["metadata"] == {"shot": 1}


@pytest.mark.parametrize(
    ("flaw", "message"),
    [
        ("base_edit_missing", "baseEdit 找不到同链里已完成的成片"),
        ("base_edit_failed", "baseEdit 找不到同链里已完成的成片"),
        ("master_before_edit", "成片找不到同链里更早的编辑结果"),
        ("coordinates", "编辑结果缺编辑坐标或坐标不成区间"),
    ],
    ids=["baseEdit 没有成片", "baseEdit 的成片失败了", "成片早于编辑结果", "编辑结果缺 editEnd"],
)
async def test_operation_migration_refuses_rows_it_cannot_place(
    migrated_pg: str, flaw: str, message: str
) -> None:
    """对不上的行不静默落成别的角色：带 id 报错，库停在 0016。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    root, edit, master, offender = (uuid.uuid4() for _ in range(4))
    take: _ChainRow = (root, "video", {"prompt": "p"}, {"shot": 1}, None, 0)
    first: dict[str, object] = {"editId": "e1", "editStart": 1, "editEnd": 2}
    based: dict[str, object] = {"baseEdit": "e1", "editId": "e2", "editStart": 1, "editEnd": 2}
    failed: frozenset[uuid.UUID] = frozenset()
    rows: tuple[_ChainRow, ...]
    if flaw == "base_edit_missing":
        rows = (take, (offender, "video", {"prompt": "p"}, based, root, 1))
    elif flaw == "base_edit_failed":
        rows = (
            take,
            (edit, "video", {"prompt": "p"}, first, root, 1),
            (master, "clip", _MASTER_REQUEST, first, root, 2),
            (offender, "video", {"prompt": "p"}, based, root, 3),
        )
        failed = frozenset({master})
    elif flaw == "master_before_edit":
        rows = (
            take,
            (offender, "clip", _MASTER_REQUEST, first, root, 1),
            (edit, "video", {"prompt": "p"}, first, root, 2),
        )
    else:
        rows = (
            take,
            (offender, "video", {"prompt": "p"}, {"editId": "e1", "editStart": 1}, root, 1),
        )
    try:
        command.downgrade(cfg, BEFORE_OPERATION)
        await _seed_before_operation(migrated_pg, owner, rows, failed=failed)
        with pytest.raises(RuntimeError, match=message) as refused:
            command.upgrade(cfg, "head")
        version = await _alembic_version(migrated_pg)
    finally:
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert str(offender) in str(refused.value), "报错要点名是哪一行"
    assert version == BEFORE_OPERATION, "整个迁移回滚，列没加上"


_OPEN_ENDED_SEGMENTS: list[dict[str, object]] = [
    {"url": "https://example.test/root.mp4", "start": 0, "end": 1},
    {"url": "https://example.test/edit.mp4", "start": 0},
]


async def _insert_since_operation(
    conn: AsyncConnection,
    job_id: uuid.UUID,
    owner: uuid.UUID,
    *,
    kind: str = "video",
    operation: str = "generate",
    metadata: Mapping[str, object] | None = None,
    source: uuid.UUID | None = None,
    root: uuid.UUID | None = None,
    span: tuple[int, int] | None = None,
    snapshot: Mapping[str, object] | None = None,
) -> None:
    """按 0017 起的形状插一行已完成的记录：编辑段给来源、原作与区间，合成给来源与原作。"""

    request: Mapping[str, object] = (
        {"segments": _OPEN_ENDED_SEGMENTS, "userName": "luke"}
        if operation == "compose"
        else {"model": "m", "prompt": "p"}
    )
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, operation, provider, "
            "request, status, metadata, source_job_id, root_job_id, range_start_ms, range_end_ms, "
            "output_url, provider_snapshot, created_at, updated_at, finished_at) VALUES (:id, "
            ":owner, :kind, :operation, 'test', CAST(:request AS jsonb), 'completed', "
            "CAST(:metadata AS jsonb), :source, :root, :start, :end, 'https://example.test/v.mp4', "
            "CAST(:snapshot AS jsonb), now(), now(), now())"
        ),
        {
            "id": job_id,
            "owner": owner,
            "kind": kind,
            "operation": operation,
            "request": json.dumps(request),
            "metadata": None if metadata is None else json.dumps(metadata),
            "source": source,
            "root": root,
            "start": None if span is None else span[0],
            "end": None if span is None else span[1],
            "snapshot": None if snapshot is None else json.dumps(snapshot),
        },
    )


async def test_operation_migration_refuses_to_downgrade_an_open_ended_composite(
    migrated_pg: str,
) -> None:
    """0017 之后的合成有取到结尾的段，旧形状要求每段都有 end：拒绝降级。

    一次命令一个事务，0017 拒绝会把前面 0020、0019、0018 的降级一起回滚，库留在 0020。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    root, edit, composite = (uuid.uuid4() for _ in range(3))
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            await _insert_since_operation(conn, root, owner)
            await _insert_since_operation(
                conn, edit, owner, source=root, root=root, span=(1000, 4000)
            )
            await _insert_since_operation(
                conn, composite, owner, operation="compose", source=edit, root=root
            )
        await engine.dispose()
        with pytest.raises(RuntimeError, match="合成里有取到结尾的段") as refused:
            command.downgrade(cfg, BEFORE_OPERATION)
        version = await _alembic_version(migrated_pg)
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert str(composite) in str(refused.value)
    assert version == IMAGE_SOURCE


async def _index_definition(migrated_pg: str, name: str) -> str:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    text(
                        "SELECT indexdef FROM pg_indexes "
                        "WHERE schemaname = 'iclip' AND indexname = :name"
                    ),
                    {"name": name},
                )
            ).scalar_one()
    finally:
        await engine.dispose()


async def test_shot_index_migration_moves_video_shots_and_composite_durations_into_columns(
    migrated_pg: str,
) -> None:
    """0018：出片的镜号取自己的 metadata.shot，编辑段与合成抄原作的、自带的旧坐标被覆盖；视频行擦掉
    shot 键，图片的坐标一个键不动、也不校验；合成的时长取自快照，快照不改写；建（对话，镜号）的
    部分索引。降级把出片的镜号与合成的时长写回 JSON，编辑段的旧坐标不还原。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    take, edit, composite, plain, tagged, whole, image, odd_image = (uuid.uuid4() for _ in range(8))
    engine = create_async_engine(migrated_pg)
    try:
        command.downgrade(cfg, OPERATION)
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            await _insert_since_operation(conn, take, owner, metadata={"shot": 2})
            await _insert_since_operation(
                conn,
                edit,
                owner,
                metadata={"shot": 7, "frame": 1},
                source=take,
                root=take,
                span=(1000, 4000),
            )
            await _insert_since_operation(
                conn,
                composite,
                owner,
                operation="compose",
                source=edit,
                root=take,
                snapshot={"durationMs": 7040},
            )
            await _insert_since_operation(conn, plain, owner)
            await _insert_since_operation(conn, tagged, owner, metadata={"note": "x"})
            await _insert_since_operation(conn, whole, owner, metadata={"shot": 4.0})
            await _insert_since_operation(
                conn, image, owner, kind="image", metadata={"shot": 3, "frame": 2}
            )
            await _insert_since_operation(
                conn, odd_image, owner, kind="image", metadata={"shot": "A", "frame": 1}
            )
        await engine.dispose()
        command.upgrade(cfg, SHOT_INDEX)
        upgraded = await _select_rows(
            migrated_pg, owner, "shot_index, duration_ms, metadata, provider_snapshot"
        )
        index = await _index_definition(migrated_pg, "ix_generation_jobs_conversation_shot")
        # 0018 之后的合成不再往快照里写时长：降级要从列里写回去。
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE iclip.generation_jobs SET provider_snapshot = NULL WHERE id = :id"),
                {"id": composite},
            )
        await engine.dispose()
        command.downgrade(cfg, OPERATION)
        restored = await _select_rows(migrated_pg, owner, "metadata, provider_snapshot")
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert {
        job_id: (row["shot_index"], row["duration_ms"], row["metadata"])
        for job_id, row in upgraded.items()
    } == {
        take: (2, None, None),
        edit: (2, None, {"frame": 1}),
        composite: (2, 7040, None),
        plain: (None, None, None),
        tagged: (None, None, {"note": "x"}),
        whole: (4, None, None),
        image: (None, None, {"shot": 3, "frame": 2}),
        odd_image: (None, None, {"shot": "A", "frame": 1}),
    }
    assert upgraded[composite]["provider_snapshot"] == {"durationMs": 7040}, "快照不改写"
    assert "(conversation_id, shot_index)" in index
    assert "kind = 'video'" in index and "shot_index IS NOT NULL" in index

    assert {job_id: row["metadata"] for job_id, row in restored.items()} == {
        take: {"shot": 2},
        edit: {"frame": 1},
        composite: None,
        plain: None,
        tagged: {"note": "x"},
        whole: {"shot": 4},
        image: {"shot": 3, "frame": 2},
        odd_image: {"shot": "A", "frame": 1},
    }, "编辑段迁移前自带的镜号已按原作覆盖，不还原"
    assert restored[composite]["provider_snapshot"] == {"durationMs": 7040}


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("shot", "3", "metadata.shot 不是正整数"),
        ("shot", 0, "metadata.shot 不是正整数"),
        ("shot", 2.5, "metadata.shot 不是正整数"),
        ("shot", -1, "metadata.shot 不是正整数"),
        ("shot", 1e10, "metadata.shot 不是正整数"),
        ("shot", None, "metadata.shot 不是正整数"),
        ("durationMs", 70.5, "durationMs 不是非负整数"),
        ("durationMs", "7040", "durationMs 不是非负整数"),
    ],
    ids=["字符串", "零", "小数", "负数", "超出 int", "null", "时长是小数", "时长是字符串"],
)
async def test_shot_index_migration_refuses_values_it_cannot_carry(
    migrated_pg: str, field: str, value: object, message: str
) -> None:
    """转不成整数列的值不静默丢掉或截断：带 id 报错，库停在 0017。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    take, edit, composite = (uuid.uuid4() for _ in range(3))
    engine = create_async_engine(migrated_pg)
    try:
        command.downgrade(cfg, OPERATION)
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            await _insert_since_operation(
                conn, take, owner, metadata={"shot": value} if field == "shot" else {"shot": 1}
            )
            await _insert_since_operation(
                conn, edit, owner, source=take, root=take, span=(1000, 4000)
            )
            await _insert_since_operation(
                conn,
                composite,
                owner,
                operation="compose",
                source=edit,
                root=take,
                snapshot={"durationMs": value} if field == "durationMs" else None,
            )
        await engine.dispose()
        with pytest.raises(RuntimeError, match=message) as refused:
            command.upgrade(cfg, SHOT_INDEX)
        version = await _alembic_version(migrated_pg)
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert str(take if field == "shot" else composite) in str(refused.value), "报错要点名是哪一行"
    assert version == OPERATION, "整个迁移回滚，列没加上"


async def _insert_account(
    conn: AsyncConnection, user_id: uuid.UUID, username: str | None, *, email: str | None = None
) -> None:
    """一个账号；``username`` 可以为空，SSO 显示名撞名时就是这样。"""

    await conn.execute(
        text(
            "INSERT INTO iclip.users (id, username, email, hashed_password, is_active, "
            "is_superuser, is_verified, display_name, avatar_url, roles, direct_permissions, "
            "city, job_title, departments) VALUES (:id, :username, :email, 'x', true, false, "
            "true, :display, '', '[]', '[]', '', '', '[]')"
        ),
        {
            "id": user_id,
            "username": username,
            "email": email or f"{user_id}@example.com",
            "display": username or "没有用户名",
        },
    )


async def _insert_named(
    conn: AsyncConnection,
    job_id: uuid.UUID,
    owner: uuid.UUID,
    *,
    request: Mapping[str, object],
    kind: str = "video",
    operation: str = "generate",
    conversation: uuid.UUID | None = None,
    source: uuid.UUID | None = None,
    root: uuid.UUID | None = None,
    span: tuple[int, int] | None = None,
    api_key_id: uuid.UUID | None = None,
) -> None:
    """按 0018 的形状插一行已完成的记录，请求原样给：名字写在哪个键、有没有，都由用例定。"""

    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, api_key_id, conversation_id, "
            "kind, operation, provider, request, status, source_job_id, root_job_id, "
            "range_start_ms, range_end_ms, output_url, created_at, updated_at, finished_at) "
            "VALUES (:id, :owner, :key, :conversation, :kind, :operation, 'test', "
            "CAST(:request AS jsonb), 'completed', :source, :root, :start, :end, "
            "'https://example.test/v.mp4', now(), now(), now())"
        ),
        {
            "id": job_id,
            "owner": owner,
            "key": api_key_id,
            "conversation": conversation,
            "kind": kind,
            "operation": operation,
            "request": json.dumps(request),
            "source": source,
            "root": root,
            "start": None if span is None else span[0],
            "end": None if span is None else span[1],
        },
    )


async def _jobs(migrated_pg: str) -> dict[uuid.UUID, tuple[object, object, object]]:
    """全表每行的（属主，钥匙，请求）：校正会换属主，按属主选行会漏掉换走的。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(
                text("SELECT id, owner_user_id, api_key_id, request FROM iclip.generation_jobs")
            )
            return {
                row.id: (row.owner_user_id, row.api_key_id, _jsonb(row.request)) for row in rows
            }
    finally:
        await engine.dispose()


async def _users(migrated_pg: str) -> dict[uuid.UUID, dict[str, object]]:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        "SELECT id, username, email, hashed_password, display_name, roles, "
                        "direct_permissions, is_active, is_superuser, is_verified, last_login_at "
                        "FROM iclip.users"
                    )
                )
            ).mappings()
            return {
                row["id"]: {
                    key: _jsonb(value) if key in ("roles", "direct_permissions") else value
                    for key, value in row.items()
                    if key != "id"
                }
                for row in rows
            }
    finally:
        await engine.dispose()


async def test_owner_fix_migration_reassigns_rows_to_the_named_account(migrated_pg: str) -> None:
    """0019：属主与请求里的名字对不上的行改归那个名字的账号，没有账号的建一个占位账号、同名只建
    一个；名字写在 user_name 或 userName 里都认，属主没有用户名也算对不上。名字为空的、与属主一致
    的、所在对话是分叉副本的不动；钥匙身份与请求原样。降级不改回，重升空转。"""

    cfg = _alembic(migrated_pg)
    luke, shan, bare, key = (uuid.uuid4() for _ in range(4))
    source_conversation, copy_conversation = uuid.uuid4(), uuid.uuid4()
    same, to_shan, edit, composite, to_new, image_new = (uuid.uuid4() for _ in range(6))
    from_bare, unnamed, null_name, blank, in_copy = (uuid.uuid4() for _ in range(5))
    video: dict[str, object] = {"model": "m", "prompt": "p"}
    requests: dict[uuid.UUID, Mapping[str, object]] = {
        same: {**video, "user_name": "Luke.Lu"},
        to_shan: {**video, "user_name": "Shan.Hu"},
        edit: {**video, "user_name": "Shan.Hu"},
        composite: {"segments": [], "userName": "Shan.Hu"},
        to_new: {**video, "user_name": "Edna.Li"},
        image_new: {"prompt": "p", "userName": "Edna.Li"},
        from_bare: {**video, "user_name": "Shan.Hu"},
        unnamed: video,
        null_name: {**video, "user_name": None},
        blank: {"prompt": "p", "userName": "  "},
        in_copy: {**video, "user_name": "Shan.Hu"},
    }
    engine = create_async_engine(migrated_pg)
    try:
        command.downgrade(cfg, SHOT_INDEX)
        async with engine.begin() as conn:
            await _insert_account(conn, luke, "Luke.Lu")
            await _insert_account(conn, shan, "Shan.Hu")
            await _insert_account(conn, bare, None)
            for conversation_id, parent, minute in (
                (source_conversation, None, 0),
                (copy_conversation, source_conversation, 1),
            ):
                await conn.execute(
                    _INSERT_FORK_CONVERSATION,
                    {
                        "id": conversation_id,
                        "owner": luke,
                        "at": _minute(minute),
                        "parent": parent,
                        "turn": None if parent is None else 1,
                    },
                )
            await _insert_named(conn, same, luke, request=requests[same])
            await _insert_named(
                conn,
                to_shan,
                luke,
                request=requests[to_shan],
                conversation=source_conversation,
                api_key_id=key,
            )
            await _insert_named(
                conn,
                edit,
                luke,
                request=requests[edit],
                conversation=source_conversation,
                source=to_shan,
                root=to_shan,
                span=(1000, 4000),
            )
            await _insert_named(
                conn,
                composite,
                luke,
                request=requests[composite],
                operation="compose",
                conversation=source_conversation,
                source=edit,
                root=to_shan,
            )
            await _insert_named(conn, to_new, luke, request=requests[to_new])
            await _insert_named(conn, image_new, luke, request=requests[image_new], kind="image")
            await _insert_named(conn, from_bare, bare, request=requests[from_bare])
            await _insert_named(conn, unnamed, luke, request=requests[unnamed])
            await _insert_named(conn, null_name, luke, request=requests[null_name])
            await _insert_named(conn, blank, luke, request=requests[blank], kind="image")
            await _insert_named(
                conn, in_copy, luke, request=requests[in_copy], conversation=copy_conversation
            )
        await engine.dispose()
        seeded = set(await _users(migrated_pg))
        command.upgrade(cfg, OWNER_FIX)
        fixed = await _jobs(migrated_pg)
        users = await _users(migrated_pg)
        command.downgrade(cfg, SHOT_INDEX)
        command.upgrade(cfg, OWNER_FIX)
        replayed = await _jobs(migrated_pg)
        replayed_users = await _users(migrated_pg)
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    [edna] = set(users) - seeded
    assert {job_id: owner for job_id, (owner, _, _) in fixed.items()} == {
        same: luke,
        to_shan: shan,
        edit: shan,
        composite: shan,
        to_new: edna,
        image_new: edna,
        from_bare: shan,
        unnamed: luke,
        null_name: luke,
        blank: luke,
        in_copy: luke,
    }
    assert fixed[to_shan][1] == key, "钥匙身份不动"
    assert {job_id: request for job_id, (_, _, request) in fixed.items()} == requests
    account = users[edna]
    assert account["email"] == placeholder_email("Edna.Li"), "SSO 首登按这个邮箱认领"
    assert {
        field: value
        for field, value in account.items()
        if field not in ("email", "hashed_password")
    } == {
        "username": "Edna.Li",
        "display_name": "Edna.Li",
        "roles": [],
        "direct_permissions": [],
        "is_active": True,
        "is_superuser": False,
        "is_verified": False,
        "last_login_at": None,
    }
    assert PasswordHelper().verify_and_update("x", str(account["hashed_password"])) == (
        False,
        None,
    ), "密码是真哈希：拿这个用户名走密码登录是干净的密码错误"
    assert (replayed, replayed_users) == (fixed, users), "降级不改回，重升空转"


@pytest.mark.parametrize(
    ("flaw", "message"),
    [
        ("too_long", "放不进用户名"),
        ("padded", "放不进用户名"),
        ("case_of_account", "与已有账号只差大小写"),
        ("case_of_each_other", "占位账号之间只差大小写"),
        ("both_keys", "同时带 user_name 与 userName"),
        ("email_taken", "占位邮箱已被别的账号占用"),
    ],
    ids=[
        "超长",
        "首尾空白",
        "与已有账号只差大小写",
        "待建名字之间只差大小写",
        "两个键",
        "占位邮箱被占",
    ],
)
async def test_owner_fix_migration_refuses_names_it_cannot_place(
    migrated_pg: str, flaw: str, message: str
) -> None:
    """放不进用户名、对不准账号的名字不猜：点名报错，库停在 0018，占位账号不留，别的行也不改。"""

    cfg = _alembic(migrated_pg)
    luke, shan = uuid.uuid4(), uuid.uuid4()
    fine, offender, twin = (uuid.uuid4() for _ in range(3))
    names: dict[uuid.UUID, Mapping[str, object]] = {fine: {"user_name": "Shan.Hu"}}
    named = [str(offender)]
    if flaw == "too_long":
        names[offender] = {"user_name": "x" * 151}
    elif flaw == "padded":
        names[offender] = {"user_name": " Shan.Hu"}
    elif flaw == "case_of_account":
        names[offender] = {"user_name": "shan.hu"}
    elif flaw == "case_of_each_other":
        names[offender] = {"user_name": "Edna.Li"}
        names[twin] = {"userName": "edna.li"}
        named.append(str(twin))
    elif flaw == "both_keys":
        names[offender] = {"user_name": "Shan.Hu", "userName": "Shan.Hu"}
    else:
        names[offender] = {"user_name": "Edna.Li"}
        named = [placeholder_email("Edna.Li")]
    engine = create_async_engine(migrated_pg)
    try:
        command.downgrade(cfg, SHOT_INDEX)
        async with engine.begin() as conn:
            await _insert_account(conn, luke, "Luke.Lu")
            await _insert_account(conn, shan, "Shan.Hu")
            if flaw == "email_taken":
                await _insert_account(
                    conn, uuid.uuid4(), "Other", email=placeholder_email("Edna.Li")
                )
            for job_id, name in names.items():
                await _insert_named(
                    conn, job_id, luke, request={"model": "m", "prompt": "p", **name}
                )
        await engine.dispose()
        seeded = set(await _users(migrated_pg))
        with pytest.raises(RuntimeError, match=message) as refused:
            command.upgrade(cfg, OWNER_FIX)
        version = await _alembic_version(migrated_pg)
        users = set(await _users(migrated_pg))
        owners = {job_id: owner for job_id, (owner, _, _) in (await _jobs(migrated_pg)).items()}
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert all(item in str(refused.value) for item in named), "报错要点名是哪几行或哪个邮箱"
    assert version == SHOT_INDEX, "整个迁移回滚"
    assert users == seeded, "占位账号没留下"
    assert owners[fine] == luke, "能校正的那行也跟着回滚"


_INSERT_BEFORE_IMAGE_SOURCE = text(
    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind, operation, "
    "provider, request, status, metadata, output_url, created_at, updated_at, finished_at) "
    "VALUES (:id, :owner, :conversation, :kind, 'generate', 'test', CAST(:request AS jsonb), "
    "'completed', CAST(:metadata AS jsonb), :url, :created, :created, :finished)"
)
_IMAGE_REQUEST = '{"prompt": "p", "aspectRatio": "1:1", "userName": "luke"}'

_ImageRow = tuple[uuid.UUID, uuid.UUID | None, Mapping[str, object] | None, int, int]
"""(id, 对话, metadata, 建立分钟, 完成分钟)；都是已完成的 image / generate，产物地址按 id 起。"""


def _image_url(job_id: uuid.UUID) -> str:
    return f"https://example.test/{job_id}.png"


async def _seed_before_image_source(
    migrated_pg: str,
    owner: uuid.UUID,
    *,
    conversations: Sequence[tuple[uuid.UUID, uuid.UUID | None, int]] = (),
    images: Sequence[_ImageRow] = (),
    videos: Sequence[tuple[uuid.UUID, Mapping[str, object] | None, str]] = (),
) -> None:
    """在 0019 的表上种对话 (id, 来源, 建立分钟)、图片与视频 (id, metadata, 请求原文)。

    不用会带 ``user_name`` 的种子：0019 重升时会为那些名字建占位账号，与这里无关。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            for conversation_id, parent, minute in conversations:
                await conn.execute(
                    _INSERT_FORK_CONVERSATION,
                    {
                        "id": conversation_id,
                        "owner": owner,
                        "at": _minute(minute),
                        "parent": parent,
                        "turn": None if parent is None else 1,
                    },
                )
            for job_id, conversation_id, metadata, created, finished in images:
                await conn.execute(
                    _INSERT_BEFORE_IMAGE_SOURCE,
                    {
                        "id": job_id,
                        "owner": owner,
                        "conversation": conversation_id,
                        "kind": "image",
                        "request": _IMAGE_REQUEST,
                        "metadata": None if metadata is None else json.dumps(metadata),
                        "url": _image_url(job_id),
                        "created": _minute(created),
                        "finished": _minute(finished),
                    },
                )
            for job_id, metadata, request in videos:
                await conn.execute(
                    _INSERT_BEFORE_IMAGE_SOURCE,
                    {
                        "id": job_id,
                        "owner": owner,
                        "conversation": None,
                        "kind": "video",
                        "request": request,
                        "metadata": None if metadata is None else json.dumps(metadata),
                        "url": f"https://example.test/{job_id}.mp4",
                        "created": _minute(0),
                        "finished": _minute(0),
                    },
                )
    finally:
        await engine.dispose()


async def _generation_columns(migrated_pg: str) -> set[str]:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            return await conn.run_sync(
                lambda sync_conn: {
                    str(column["name"])
                    for column in inspect(sync_conn).get_columns(
                        "generation_jobs", schema=DB_SCHEMA
                    )
                }
            )
    finally:
        await engine.dispose()


_IMAGE_SOURCE_CHECKS = {
    "ck_generation_jobs_kind",
    "ck_generation_jobs_operation",
    "ck_generation_jobs_request",
    "ck_generation_jobs_video_shape",
    "ck_generation_jobs_image_shape",
    "ck_generation_jobs_cut_shape",
    "ck_generation_jobs_upload_shape",
    "ck_generation_jobs_settled",
}


async def test_image_source_migration_resolves_bases_and_strips_the_key(migrated_pg: str) -> None:
    """0020：帧图编辑的底图地址对上本对话里提交时已完成的图（上一次编辑也算）、或按继承读得到的祖先
    记录，就记 source_job_id；对不上的（分叉之后才完成、别的对话、提交时还没完成、外部地址）进
    source_url。图片行擦掉 sourceUrl 键、只剩它的 metadata 变空，视频行一个键不动。降级按来源写回
    原值，重升结果不变。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    source, fork, other = (uuid.uuid4() for _ in range(3))
    base, edit, edit_of_edit, after_fork, inherited, beyond = (uuid.uuid4() for _ in range(6))
    foreign, elsewhere, late_base, too_early, external, bare, plain, take = (
        uuid.uuid4() for _ in range(8)
    )
    cell = "https://example.test/shot-frames/old/out/S1-1.jpg"
    seeded: dict[uuid.UUID, Mapping[str, object] | None] = {
        base: None,
        edit: {"shot": 1, "frame": 1, "sourceUrl": _image_url(base)},
        edit_of_edit: {"shot": 1, "frame": 1, "sourceUrl": _image_url(edit)},
        after_fork: None,
        inherited: {"shot": 1, "frame": 2, "sourceUrl": _image_url(base)},
        beyond: {"shot": 1, "frame": 3, "sourceUrl": _image_url(after_fork)},
        foreign: None,
        elsewhere: {"shot": 2, "frame": 1, "sourceUrl": _image_url(foreign)},
        late_base: None,
        too_early: {"shot": 2, "frame": 2, "sourceUrl": _image_url(late_base)},
        external: {"shot": 3, "frame": 1, "sourceUrl": cell},
        bare: {"sourceUrl": _image_url(base)},
        plain: {"shot": 3, "frame": 2},
        take: {"sourceUrl": "https://example.test/still.jpg"},
    }
    placed = {  # (对话, 建立分钟, 完成分钟)；副本在第 10 分钟从源对话分出来
        base: (source, 1, 2),
        edit: (source, 3, 4),
        edit_of_edit: (source, 5, 6),
        after_fork: (source, 11, 12),
        inherited: (fork, 13, 14),
        beyond: (fork, 15, 16),
        foreign: (other, 1, 2),
        elsewhere: (source, 17, 18),
        late_base: (source, 19, 21),
        too_early: (source, 20, 22),
        external: (source, 23, 24),
        bare: (source, 25, 26),
        plain: (source, 27, 28),
    }
    try:
        command.downgrade(cfg, OWNER_FIX)
        await _seed_before_image_source(
            migrated_pg,
            owner,
            conversations=((source, None, 0), (other, None, 0), (fork, source, 10)),
            images=[
                (job_id, conversation, seeded[job_id], created, finished)
                for job_id, (conversation, created, finished) in placed.items()
            ],
            videos=[(take, seeded[take], '{"model": "m", "prompt": "p"}')],
        )
        command.upgrade(cfg, IMAGE_SOURCE)
        upgraded = await _select_rows(migrated_pg, owner, "source_job_id, source_url, metadata")
        shape = await _generation_shape(migrated_pg)
        command.downgrade(cfg, OWNER_FIX)
        restored = await _select_rows(migrated_pg, owner, "source_job_id, metadata")
        columns = await _generation_columns(migrated_pg)
        command.upgrade(cfg, IMAGE_SOURCE)
        replayed = await _select_rows(migrated_pg, owner, "source_job_id, source_url, metadata")
    finally:
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert {
        job_id: (row["source_job_id"], row["source_url"], row["metadata"])
        for job_id, row in upgraded.items()
    } == {
        base: (None, None, None),
        edit: (base, None, {"shot": 1, "frame": 1}),
        edit_of_edit: (edit, None, {"shot": 1, "frame": 1}),
        after_fork: (None, None, None),
        inherited: (base, None, {"shot": 1, "frame": 2}),
        beyond: (None, _image_url(after_fork), {"shot": 1, "frame": 3}),
        foreign: (None, None, None),
        elsewhere: (None, _image_url(foreign), {"shot": 2, "frame": 1}),
        late_base: (None, None, None),
        too_early: (None, _image_url(late_base), {"shot": 2, "frame": 2}),
        external: (None, cell, {"shot": 3, "frame": 1}),
        bare: (base, None, None),
        plain: (None, None, {"shot": 3, "frame": 2}),
        take: (None, None, {"sourceUrl": "https://example.test/still.jpg"}),
    }
    assert shape["checks"] == _IMAGE_SOURCE_CHECKS
    assert "ix_generation_jobs_conversation_image_output" in shape["indexes"]
    assert "request" not in shape["not_null"], "上传与切图没有请求"

    assert {job_id: row["metadata"] for job_id, row in restored.items()} == seeded
    assert {row["source_job_id"] for row in restored.values()} == {None}
    assert "source_url" not in columns
    assert replayed == upgraded, "降级再升，回填出同样的结果"


@pytest.mark.parametrize(
    ("flaw", "message"),
    [
        ("request", "请求不是 JSON 对象"),
        ("number", r"metadata\.sourceUrl 不是 http\(s\) 地址"),
        ("data_url", r"metadata\.sourceUrl 不是 http\(s\) 地址"),
        ("ambiguous", "底图地址对得上不止一条记录"),
    ],
    ids=["请求是 JSON 字符串", "sourceUrl 是数字", "sourceUrl 是 data 地址", "底图对上两条"],
)
async def test_image_source_migration_refuses_rows_it_cannot_place(
    migrated_pg: str, flaw: str, message: str
) -> None:
    """放不进新形状、说不清底图是哪一条的行交人判断：点名报错，库停在 0019，能回填的那行也不动。"""

    cfg = _alembic(migrated_pg)
    owner, conversation = uuid.uuid4(), uuid.uuid4()
    base, fine, offender, twin = (uuid.uuid4() for _ in range(4))
    fine_metadata = {"shot": 1, "frame": 1, "sourceUrl": _image_url(base)}
    images: list[_ImageRow] = [
        (base, conversation, None, 1, 2),
        (fine, conversation, fine_metadata, 3, 4),
    ]
    videos: list[tuple[uuid.UUID, Mapping[str, object] | None, str]] = []
    if flaw == "request":
        videos.append((offender, None, '"x"'))
    elif flaw == "number":
        images.append((offender, conversation, {"shot": 1, "frame": 2, "sourceUrl": 42}, 5, 6))
    elif flaw == "data_url":
        bad = {"shot": 1, "frame": 2, "sourceUrl": "data:image/png;base64,AAAA"}
        images.append((offender, conversation, bad, 5, 6))
    else:
        images.append((twin, conversation, None, 1, 2))
        shared = {"shot": 1, "frame": 2, "sourceUrl": _image_url(twin)}
        images.append((offender, conversation, shared, 5, 6))
    engine = create_async_engine(migrated_pg)
    try:
        command.downgrade(cfg, OWNER_FIX)
        await _seed_before_image_source(
            migrated_pg,
            owner,
            conversations=((conversation, None, 0),),
            images=images,
            videos=videos,
        )
        if flaw == "ambiguous":
            # 两张图产物地址相同：说不清编辑改的是哪一张。
            async with engine.begin() as conn:
                await conn.execute(
                    text("UPDATE iclip.generation_jobs SET output_url = :url WHERE id = :id"),
                    {"url": _image_url(twin), "id": base},
                )
        with pytest.raises(RuntimeError, match=message) as refused:
            command.upgrade(cfg, IMAGE_SOURCE)
        version = await _alembic_version(migrated_pg)
        kept = await _select_rows(migrated_pg, owner, "metadata")
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert str(offender) in str(refused.value), "报错要点名是哪一行"
    assert version == OWNER_FIX, "整个迁移回滚"
    assert kept[fine]["metadata"] == fine_metadata, "能回填的那行也跟着回滚"


_INSERT_AT_IMAGE_SOURCE = text(
    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind, operation, "
    "provider, request, status, metadata, source_job_id, source_url, output_url, created_at, "
    "updated_at, finished_at) VALUES (:id, :owner, :conversation, 'image', :operation, "
    ":operation, CAST(:request AS jsonb), 'completed', CAST(:metadata AS jsonb), :source, "
    ":source_url, :url, now(), now(), now())"
)


async def _seed_settled_rows(
    conn: AsyncConnection, owner: uuid.UUID, conversation: uuid.UUID
) -> dict[str, uuid.UUID]:
    """按 0020 的形状种一条上传、一张宫格与它切出的两格，以及以切格、上传、外部地址为底图的三条编辑。

    以切格为底图的那条 metadata 是 JSON null：仓储把 ``None`` 存成它，降级写回不能把它拼成数组。"""

    ids = {
        name: uuid.uuid4()
        for name in ("upload", "grid", "cell_1", "cell_2", "on_cell", "on_upload", "on_external")
    }
    rows: list[tuple[str, str, uuid.UUID | None, str | None, str | None, str | None]] = [
        ("upload", "upload", None, None, None, None),
        ("grid", "generate", conversation, _IMAGE_REQUEST, None, None),
        ("cell_1", "cut", conversation, None, None, "grid"),
        ("cell_2", "cut", conversation, None, None, "grid"),
        ("on_cell", "generate", conversation, _IMAGE_REQUEST, "null", "cell_1"),
        (
            "on_upload",
            "generate",
            conversation,
            _IMAGE_REQUEST,
            '{"shot": 1, "frame": 2}',
            "upload",
        ),
        ("on_external", "generate", conversation, _IMAGE_REQUEST, None, None),
    ]
    await _insert_generation_owner(conn, owner)
    for name, operation, conversation_id, request, metadata, source in rows:
        await conn.execute(
            _INSERT_AT_IMAGE_SOURCE,
            {
                "id": ids[name],
                "owner": owner,
                "conversation": conversation_id,
                "operation": operation,
                "request": request,
                "metadata": metadata,
                "source": None if source is None else ids[source],
                "source_url": _EXTERNAL_BASE if name == "on_external" else None,
                "url": _image_url(ids[name]),
            },
        )
    return ids


_EXTERNAL_BASE = "https://example.test/shot-frames/old/out/S2-1.jpg"


async def test_image_source_downgrade_drops_settled_rows_and_writes_bases_back(
    migrated_pg: str,
) -> None:
    """降级删掉切图行与上传行，帧图编辑的来源写回 metadata.sourceUrl：库内来源取那条的产物地址，
    外部地址原样；原来的键留着，JSON null 的从空对象起。"""

    cfg = _alembic(migrated_pg)
    owner, conversation = uuid.uuid4(), uuid.uuid4()
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            ids = await _seed_settled_rows(conn, owner, conversation)
        await engine.dispose()
        command.downgrade(cfg, OWNER_FIX)
        restored = await _select_rows(migrated_pg, owner, "source_job_id, metadata")
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert restored == {
        ids["grid"]: {"source_job_id": None, "metadata": None},
        ids["on_cell"]: {
            "source_job_id": None,
            "metadata": {"sourceUrl": _image_url(ids["cell_1"])},
        },
        ids["on_upload"]: {
            "source_job_id": None,
            "metadata": {"shot": 1, "frame": 2, "sourceUrl": _image_url(ids["upload"])},
        },
        ids["on_external"]: {"source_job_id": None, "metadata": {"sourceUrl": _EXTERNAL_BASE}},
    }, "切图行与上传行删掉，其余写回底图地址"


async def test_image_source_downgrade_refuses_settled_rows_with_tracking_events(
    migrated_pg: str,
) -> None:
    """切图或上传记录上挂着埋点事件，删不掉：点名拒绝，停在 0020，一行不动。"""

    cfg = _alembic(migrated_pg)
    owner, conversation = uuid.uuid4(), uuid.uuid4()
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            ids = await _seed_settled_rows(conn, owner, conversation)
            await conn.execute(
                _INSERT_DOWNLOAD, {"id": uuid.uuid4(), "job": ids["cell_2"], "owner": owner}
            )
        await engine.dispose()
        with pytest.raises(RuntimeError, match="切图或上传记录上挂着埋点事件") as refused:
            command.downgrade(cfg, OWNER_FIX)
        version = await _alembic_version(migrated_pg)
        kept = await _select_rows(migrated_pg, owner, "source_job_id")
    finally:
        await engine.dispose()
        await _clear(migrated_pg)
        command.upgrade(cfg, "head")

    assert str(ids["cell_2"]) in str(refused.value), "报错要点名是哪一行"
    assert version == IMAGE_SOURCE
    assert set(kept) == set(ids.values())
    assert kept[ids["on_cell"]]["source_job_id"] == ids["cell_1"]
