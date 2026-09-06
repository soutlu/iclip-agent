"""在独立测试数据库验证旧需求单迁移、数据关系和失败回滚。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url

OLD_REVISION = "5e2a9c47b013"
NEW_REVISION = "7c8e15d2b604"


@pytest.fixture
def migration_database(pg_url: str) -> Generator[tuple[Config, Engine]]:
    """每个用例新建独立数据库，不改变会话共享测试库的迁移版本。"""

    db_name = "task_inputs_" + uuid.uuid4().hex
    base_url = make_url(pg_url)
    admin = create_engine(
        base_url.set(drivername="postgresql+psycopg"), isolation_level="AUTOCOMMIT"
    )
    with admin.connect() as conn:
        # 数据库标识由本测试生成，不能通过值参数绑定。
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
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        admin.dispose()


def seed(
    engine: Engine, *, style: dict[str, Any] | None = None, brief: dict[str, Any] | None = None
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    user_id, task_id, conversation_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    style = (
        style
        if style is not None
        else {
            "styleNo": "SKU-1",
            "brand": "品牌甲",
            "category": "鞋靴",
            "previewImageUrl": "https://example.com/product.jpg",
            "future_product_field": {"key": "保留商品补充"},
        }
    )
    brief = (
        brief
        if brief is not None
        else {
            "platform": "douyin",
            "videoType": "product_showcase",
            "contentType": "short_video",
            "durationSeconds": 15,
            "ratio": "9:16",
            "requirementDescription": "原始创作要求",
            "theme": "主题甲",
            "purpose": "目的甲",
            "audience": "受众甲",
            "selling": "卖点甲",
            "scene": "场景甲",
            "department": "部门甲",
            "requester": "需求方甲",
            "language": "中文",
            "color": "红色",
            "referenceImages": ["https://example.com/one.jpg", "https://example.com/two.jpg"],
            "referenceVideos": ["https://example.com/one.mp4", "https://example.com/two.mp4"],
            "styleNos": ["SKU-1", "SKU-2", "SKU-3"],
            "future_brief_field": ["保留需求补充"],
            "future_flag": False,
            "future_count": 0,
        }
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser, is_verified,"
                " display_name, avatar_url, roles, direct_permissions, city, job_title, departments)"
                " VALUES (:id, :email, '', true, false, true, '测试用户', '', '[]', '[]', '', '', '[]')"
            ),
            {"id": user_id, "email": f"{user_id}@example.com"},
        )
        conn.execute(
            text(
                "INSERT INTO iclip.tasks (id, title, status, priority, deadline, creator_user_id, style, brief, created_at, updated_at)"
                " VALUES (:id, '需要保留的标题', 'confirmed', 7, '2026-10-01T00:00:00Z', :user_id,"
                " CAST(:style AS jsonb), CAST(:brief AS jsonb), '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')"
            ),
            {
                "id": task_id,
                "user_id": user_id,
                "style": json.dumps(style),
                "brief": json.dumps(brief),
            },
        )
        conn.execute(
            text(
                "INSERT INTO iclip.task_assignees (task_id, user_id, created_at) VALUES (:task_id, :user_id, now())"
            ),
            {"task_id": task_id, "user_id": user_id},
        )
        conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, task_id, created_at, updated_at)"
                " VALUES (:id, :user_id, 'test-agent', '创作尝试', :task_id, now(), now())"
            ),
            {"id": conversation_id, "user_id": user_id, "task_id": task_id},
        )
    return user_id, task_id, conversation_id


def test_migration_preserves_inputs_management_and_relationships(
    migration_database: tuple[Config, Engine],
) -> None:
    cfg, engine = migration_database
    user_id, task_id, conversation_id = seed(engine)
    with engine.connect() as conn:
        before = dict(
            conn.execute(text("SELECT * FROM iclip.tasks WHERE id = :id"), {"id": task_id})
            .mappings()
            .one()
        )
        assignee_before = dict(
            conn.execute(
                text("SELECT * FROM iclip.task_assignees WHERE task_id = :id"), {"id": task_id}
            )
            .mappings()
            .one()
        )
    command.upgrade(cfg, NEW_REVISION)
    with engine.connect() as conn:
        after = dict(
            conn.execute(text("SELECT * FROM iclip.tasks WHERE id = :id"), {"id": task_id})
            .mappings()
            .one()
        )
        assert (
            dict(
                conn.execute(
                    text("SELECT * FROM iclip.task_assignees WHERE task_id = :id"), {"id": task_id}
                )
                .mappings()
                .one()
            )
            == assignee_before
        )
        assert (
            conn.execute(
                text("SELECT task_id FROM iclip.conversations WHERE id = :id"),
                {"id": conversation_id},
            ).scalar_one()
            == task_id
        )
    assert {key: value for key, value in before.items() if key not in {"style", "brief"}} == {
        key: value for key, value in after.items() if key != "inputs"
    }
    inputs = after["inputs"]
    assert inputs["product"] == {
        "style_no": "SKU-1",
        "name": "",
        "image_oss_urls": ["https://example.com/product.jpg"],
    }
    assert inputs["video_spec"] == {
        "platform": "douyin",
        "video_type": "product_showcase",
        "content_type": "short_video",
        "resolution": "",
        "aspect_ratio": "9:16",
        "duration_seconds": 15,
    }
    assert inputs["reference_image_oss_urls"] == {"model": [], "outfit": [], "prop": []}
    assert inputs["reference_video_oss_url"] == "https://example.com/one.mp4"
    assert inputs["creative_requirement"] == "\n\n".join(
        [
            "原始创作要求",
            "主题：主题甲",
            "目的：目的甲",
            "受众：受众甲",
            "卖点：卖点甲",
            "场景：场景甲",
            "部门：部门甲",
            "需求方：需求方甲",
            "语言：中文",
            "颜色：红色",
            "品牌：品牌甲",
            "品类：鞋靴",
            "未分类参考图片：\nhttps://example.com/one.jpg\nhttps://example.com/two.jpg",
            "额外款号：\nSKU-2\nSKU-3",
            "额外参考视频：\nhttps://example.com/two.mp4",
            '补充信息（style.future_product_field）：{"key": "保留商品补充"}',
            "补充信息（brief.future_flag）：false",
            "补充信息（brief.future_count）：0",
            '补充信息（brief.future_brief_field）：["保留需求补充"]',
        ]
    )
    foreign_keys = inspect(engine).get_foreign_keys("tasks", schema="iclip")
    assert any(
        fk["constrained_columns"] == ["creator_user_id"]
        and fk.get("options", {}).get("ondelete") == "RESTRICT"
        for fk in foreign_keys
    )
    assert after["creator_user_id"] == user_id
    with pytest.raises(RuntimeError, match="迁移前备份"):
        command.downgrade(cfg, OLD_REVISION)
    with engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT inputs FROM iclip.tasks WHERE id = :id"), {"id": task_id}
            ).scalar_one()
            == inputs
        )


@pytest.mark.parametrize(
    "brief",
    [
        {"requirementDescription": "x" * 4000, "theme": "不能丢弃"},
        {"referenceImages": ["file:///private.jpg"]},
        {"durationSeconds": "15"},
    ],
)
def test_invalid_or_overlong_rows_roll_back_without_exposing_content(
    migration_database: tuple[Config, Engine], brief: dict[str, Any]
) -> None:
    cfg, engine = migration_database
    _, task_id, _ = seed(engine, brief=brief)
    with pytest.raises(RuntimeError, match=str(task_id)) as raised:
        command.upgrade(cfg, NEW_REVISION)
    assert "file:///private.jpg" not in str(raised.value)
    assert "不能丢弃" not in str(raised.value)
    assert {column["name"] for column in inspect(engine).get_columns("tasks", schema="iclip")} >= {
        "style",
        "brief",
    }
    assert "inputs" not in {
        column["name"] for column in inspect(engine).get_columns("tasks", schema="iclip")
    }
    with engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT brief FROM iclip.tasks WHERE id = :id"), {"id": task_id}
            ).scalar_one()
            == brief
        )
        assert (
            conn.execute(text("SELECT version_num FROM iclip.alembic_version")).scalar_one()
            == OLD_REVISION
        )


def test_empty_database_can_downgrade_and_upgrade(
    migration_database: tuple[Config, Engine],
) -> None:
    cfg, engine = migration_database
    command.upgrade(cfg, NEW_REVISION)
    command.downgrade(cfg, OLD_REVISION)
    assert {column["name"] for column in inspect(engine).get_columns("tasks", schema="iclip")} >= {
        "style",
        "brief",
    }
    command.upgrade(cfg, NEW_REVISION)
    assert "inputs" in {
        column["name"] for column in inspect(engine).get_columns("tasks", schema="iclip")
    }
