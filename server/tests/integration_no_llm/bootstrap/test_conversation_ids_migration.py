"""在一次性数据库验证已用对话 ID 的历史回填与永久占用。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Uuid, create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import IntegrityError

OLD_REVISION = "1f6b30a94c72"
NEW_REVISION = "2b81a3dfe6c4"

SOURCE_QUERIES = {
    "conversations": "SELECT * FROM iclip.conversations ORDER BY id",
    "generation_jobs": "SELECT * FROM iclip.generation_jobs ORDER BY id",
    "runs": "SELECT * FROM agent_runtime.runs ORDER BY run_id",
    "events": "SELECT * FROM agent_runtime.events ORDER BY seq",
    "snapshots": "SELECT * FROM agent_runtime.snapshots ORDER BY seq",
    "agent_jobs": "SELECT * FROM agent_runtime.agent_jobs ORDER BY prompt_id",
}

RUNTIME_INSERTS = {
    "runs": (
        "INSERT INTO agent_runtime.runs "
        "(run_id, conversation_id, agent_name, metadata, started_at) "
        "VALUES (:record_id, :conversation_id, 'migration-agent', :payload, now())"
    ),
    "events": (
        "INSERT INTO agent_runtime.events "
        "(run_id, conversation_id, kind, step_index, timestamp, metadata) "
        "VALUES (:record_id, :conversation_id, 'run_started', 0, now(), :payload)"
    ),
    "snapshots": (
        "INSERT INTO agent_runtime.snapshots "
        "(run_id, conversation_id, step_index, timestamp, messages) "
        "VALUES (:record_id, :conversation_id, 1, now(), :payload)"
    ),
    "agent_jobs": (
        "INSERT INTO agent_runtime.agent_jobs "
        "(prompt_id, conversation_id, agent_id, owner_user_id, content, status, created_at) "
        "VALUES (:record_id, :conversation_id, 'migration-agent', :owner_id, :payload, 'completed', now())"
    ),
}


@pytest.fixture
def migration_database(pg_url: str) -> Generator[tuple[Config, Engine]]:
    """单独建库并从旧 revision 开始，不更改其他数据库测试的迁移版本。"""

    db_name = "conversation_ids_" + uuid.uuid4().hex
    base_url = make_url(pg_url)
    admin = create_engine(
        base_url.set(drivername="postgresql+psycopg"), isolation_level="AUTOCOMMIT"
    )
    with admin.connect() as conn:
        # 数据库名完全由测试生成；SQL 标识不能通过值参数绑定。
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    url = base_url.set(database=db_name)
    engine = create_engine(url.set(drivername="postgresql+psycopg"))
    server_dir = Path(__file__).resolve().parents[3]
    cfg = Config(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    cfg.attributes["sqlalchemy_url"] = url.render_as_string(hide_password=False)
    try:
        command.upgrade(cfg, OLD_REVISION)
        yield cfg, engine
    finally:
        engine.dispose()
        try:
            with admin.connect() as conn:
                conn.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        finally:
            admin.dispose()


def seed_conversations(engine: Engine, *conversation_ids: uuid.UUID) -> uuid.UUID:
    owner_id = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO iclip.users "
                "(id, email, hashed_password, is_active, is_superuser, is_verified, "
                "display_name, avatar_url, roles, direct_permissions, city, job_title, departments) "
                "VALUES (:id, :email, '', true, false, true, '迁移测试用户', '', '[]', '[]', '', '', '[]')"
            ),
            {"id": owner_id, "email": f"{owner_id}@example.com"},
        )
        conn.execute(
            text(
                "INSERT INTO iclip.conversations "
                "(id, owner_user_id, agent_id, title, title_kind, created_at, updated_at) "
                "VALUES (:id, :owner_id, 'migration-agent', '需要保留的对话', 'custom', now(), now())"
            ),
            [{"id": conversation_id, "owner_id": owner_id} for conversation_id in conversation_ids],
        )
    return owner_id


def source_rows(engine: Engine) -> dict[str, list[dict[str, Any]]]:
    with engine.connect() as conn:
        return {
            name: [dict(row) for row in conn.execute(text(query)).mappings()]
            for name, query in SOURCE_QUERIES.items()
        }


def reserved_ids(engine: Engine) -> set[uuid.UUID]:
    with engine.connect() as conn:
        return set(conn.execute(text("SELECT id FROM iclip.conversation_ids")).scalars())


def test_backfill_covers_each_history_source_without_changing_original_rows(
    migration_database: tuple[Config, Engine],
) -> None:
    cfg, engine = migration_database
    active_id, generation_only_id = uuid.uuid4(), uuid.uuid4()
    runtime_only_ids = {source: uuid.uuid4() for source in RUNTIME_INSERTS}
    owner_id = seed_conversations(engine, active_id)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs "
                "(id, owner_user_id, conversation_id, kind, provider, request, status, output_url, "
                "created_at, updated_at) "
                "VALUES (:id, :owner_id, :conversation_id, 'video', 'migration-provider', "
                "CAST(:request AS jsonb), 'completed', 'https://example.com/history.mp4', now(), now())"
            ),
            [
                {
                    "id": uuid.uuid4(),
                    "owner_id": owner_id,
                    "conversation_id": conversation_id,
                    "request": json.dumps({"prompt": "生成记录的原始描述"}, ensure_ascii=False),
                }
                for conversation_id in (generation_only_id, active_id, None)
            ],
        )
        for source, statement in RUNTIME_INSERTS.items():
            # 每张历史表各有一个其他来源不存在的 ID；运行表没有业务对话外键。
            conversation_values: list[str | None] = [
                str(runtime_only_ids[source]).upper(),
                str(active_id),
                str(active_id).upper(),
                "harness-session-not-a-uuid",
                "not-a-valid-uuid-0000-000000000000",
                "",
            ]
            if source != "agent_jobs":
                conversation_values.append(None)
            conn.execute(
                text(statement),
                [
                    {
                        "record_id": str(uuid.uuid4()),
                        "conversation_id": conversation_id,
                        "owner_id": owner_id,
                        "payload": json.dumps(
                            {"source": source, "content": "保留原始历史内容"}, ensure_ascii=False
                        ),
                    }
                    for conversation_id in conversation_values
                ],
            )
    before = source_rows(engine)
    assert not inspect(engine).has_table("conversation_ids", schema="iclip")

    command.upgrade(cfg, NEW_REVISION)

    assert reserved_ids(engine) == {active_id, generation_only_id, *runtime_only_ids.values()}
    assert source_rows(engine) == before
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM iclip.alembic_version")).scalar_one() == (
            NEW_REVISION
        )


def test_reserved_ids_have_uuid_primary_key_and_survive_conversation_and_user_deletion(
    migration_database: tuple[Config, Engine],
) -> None:
    cfg, engine = migration_database
    explicitly_deleted, cascade_deleted = uuid.uuid4(), uuid.uuid4()
    owner_id = seed_conversations(engine, explicitly_deleted, cascade_deleted)
    command.upgrade(cfg, NEW_REVISION)

    schema = inspect(engine)
    columns = schema.get_columns("conversation_ids", schema="iclip")
    assert [column["name"] for column in columns] == ["id"]
    assert isinstance(columns[0]["type"], Uuid)
    assert columns[0]["nullable"] is False
    assert schema.get_pk_constraint("conversation_ids", schema="iclip")["constrained_columns"] == [
        "id"
    ]
    assert schema.get_foreign_keys("conversation_ids", schema="iclip") == []
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text("INSERT INTO iclip.conversation_ids (id) VALUES (:id)"),
            {"id": explicitly_deleted},
        )

    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM iclip.conversations WHERE id = :id"),
            {"id": explicitly_deleted},
        )
    assert reserved_ids(engine) == {explicitly_deleted, cascade_deleted}

    with engine.begin() as conn:
        conn.execute(text("DELETE FROM iclip.users WHERE id = :id"), {"id": owner_id})
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM iclip.conversations")).scalar_one() == 0
    assert reserved_ids(engine) == {explicitly_deleted, cascade_deleted}
