"""在独立测试数据库验证单商品需求单升级成商品列表、坏数据回滚与禁止降级。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url

OLD_REVISION = "4a9c2f7e6d13"
NEW_REVISION = "c5d8a2f47e19"

SINGLE_PRODUCT_INPUTS: dict[str, Any] = {
    "video_spec": {
        "platform": "douyin",
        "video_type": "product_showcase",
        "content_type": "short_video",
        "resolution": "",
        "aspect_ratio": "9:16",
        "duration_seconds": 15,
    },
    "product": {
        "style_no": "SKU-1",
        "name": "及膝长靴",
        "image_oss_urls": ["https://example.com/product.jpg"],
    },
    "reference_image_oss_urls": {
        "model": ["https://example.com/model.jpg"],
        "outfit": [],
        "prop": [],
    },
    "reference_video_oss_url": "https://example.com/one.mp4",
    "creative_requirement": "原始创作要求",
}


@pytest.fixture
def migration_database(pg_url: str) -> Generator[tuple[Config, Engine]]:
    """每个用例新建独立数据库，不改变会话共享测试库的迁移版本。"""

    db_name = "task_products_" + uuid.uuid4().hex
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


def seed(engine: Engine, inputs: dict[str, Any]) -> uuid.UUID:
    user_id, task_id = uuid.uuid4(), uuid.uuid4()
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
                "INSERT INTO iclip.tasks (id, title, status, priority, deadline, creator_user_id, inputs, created_at, updated_at)"
                " VALUES (:id, '需要保留的标题', 'confirmed', 7, '2026-10-01T00:00:00Z', :user_id,"
                " CAST(:inputs AS jsonb), '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')"
            ),
            {"id": task_id, "user_id": user_id, "inputs": json.dumps(inputs)},
        )
    return task_id


def read_task(engine: Engine, task_id: uuid.UUID) -> dict[str, Any]:
    with engine.connect() as conn:
        return dict(
            conn.execute(text("SELECT * FROM iclip.tasks WHERE id = :id"), {"id": task_id})
            .mappings()
            .one()
        )


def test_single_product_becomes_first_list_item(
    migration_database: tuple[Config, Engine],
) -> None:
    cfg, engine = migration_database
    task_id = seed(engine, SINGLE_PRODUCT_INPUTS)
    before = read_task(engine, task_id)

    command.upgrade(cfg, NEW_REVISION)

    after = read_task(engine, task_id)
    assert {key: value for key, value in before.items() if key != "inputs"} == {
        key: value for key, value in after.items() if key != "inputs"
    }
    assert after["inputs"] == {
        **{key: value for key, value in SINGLE_PRODUCT_INPUTS.items() if key != "product"},
        "products": [
            {
                "style_no": "SKU-1",
                "name": "及膝长靴",
                "brand": "",
                "category": "",
                "color_name": "",
                "image_oss_urls": ["https://example.com/product.jpg"],
            }
        ],
    }
    with pytest.raises(RuntimeError, match="迁移前备份"):
        command.downgrade(cfg, OLD_REVISION)
    assert read_task(engine, task_id)["inputs"] == after["inputs"]


@pytest.mark.parametrize(
    "inputs",
    [
        {**SINGLE_PRODUCT_INPUTS, "product": {"style_no": "SKU-1", "extra": "x"}},
        {**SINGLE_PRODUCT_INPUTS, "products": []},
        {key: value for key, value in SINGLE_PRODUCT_INPUTS.items() if key != "product"},
    ],
)
def test_unknown_shapes_roll_back_untouched(
    migration_database: tuple[Config, Engine], inputs: dict[str, Any]
) -> None:
    cfg, engine = migration_database
    task_id = seed(engine, inputs)
    with pytest.raises(RuntimeError, match=str(task_id)):
        command.upgrade(cfg, NEW_REVISION)
    assert read_task(engine, task_id)["inputs"] == inputs
    with engine.connect() as conn:
        assert (
            conn.execute(text("SELECT version_num FROM iclip.alembic_version")).scalar_one()
            == OLD_REVISION
        )
