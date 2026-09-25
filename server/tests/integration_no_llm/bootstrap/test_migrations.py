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
from sqlalchemy import MetaData, inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from iclip.domains.collections.infra_sql import metadata_obj as collections_metadata
from iclip.domains.conversations.infra_sql import metadata_obj as conversations_metadata
from iclip.domains.generation.infra_sql import metadata_obj as generation_metadata
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
"""0017：记录上有了 operation、来源与区间，参考片段不再落行的那一版。"""

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
                    key: _jsonb(value) if key in ("request", "metadata") else value
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
        command.upgrade(cfg, "head")
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


async def test_operation_migration_refuses_to_downgrade_an_open_ended_composite(
    migrated_pg: str,
) -> None:
    """0017 之后的合成有取到结尾的段，旧形状要求每段都有 end：拒绝降级，库留在 0017。"""

    cfg = _alembic(migrated_pg)
    owner = uuid.uuid4()
    root, edit, composite = (uuid.uuid4() for _ in range(3))
    rows = (
        (root, "generate", None, None, None, {"model": "m", "prompt": "p"}),
        (edit, "generate", root, root, (1000, 4000), {"model": "m", "prompt": "p"}),
        (
            composite,
            "compose",
            edit,
            root,
            None,
            {
                "segments": [
                    {"url": "https://example.test/root.mp4", "start": 0, "end": 1},
                    {"url": "https://example.test/edit.mp4", "start": 0},
                ],
                "userName": "luke",
            },
        ),
    )
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await _insert_generation_owner(conn, owner)
            for job_id, operation, source, root_id, span, request in rows:
                await conn.execute(
                    text(
                        "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, operation, "
                        "provider, request, status, source_job_id, root_job_id, range_start_ms, "
                        "range_end_ms, output_url, created_at, updated_at, finished_at) VALUES "
                        "(:id, :owner, 'video', :operation, 'test', CAST(:request AS jsonb), "
                        "'completed', :source, :root, :start, :end, 'https://example.test/v.mp4', "
                        "now(), now(), now())"
                    ),
                    {
                        "id": job_id,
                        "owner": owner,
                        "operation": operation,
                        "request": json.dumps(request),
                        "source": source,
                        "root": root_id,
                        "start": None if span is None else span[0],
                        "end": None if span is None else span[1],
                    },
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
    assert version == OPERATION
