"""需求单商品改成列表：inputs.product → inputs.products。

Revision ID: c5d8a2f47e19
Revises: 4a9c2f7e6d13
Create Date: 2026-09-08 15:00:00.000000

存量单只有一款商品，原样放进列表第一项；新加的品牌、品类、颜色三项留空。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c5d8a2f47e19"
down_revision: str | None = "4a9c2f7e6d13"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"

_SINGLE_PRODUCT_KEYS = {"style_no", "name", "image_oss_urls"}


def _inputs(inputs: Any) -> dict[str, Any]:
    """只认应用写入过的单商品形状，别的形状一律报错，不猜。"""

    if not isinstance(inputs, dict) or "products" in inputs:
        raise ValueError("inputs 不是待迁移的单商品形状")
    product = inputs.get("product")
    if not isinstance(product, dict) or set(product) != _SINGLE_PRODUCT_KEYS:
        raise ValueError("inputs.product 形状非法")
    style_no = product["style_no"]
    if not isinstance(style_no, str) or not style_no.strip():
        raise ValueError("商品款号不能为空")
    rest = {key: value for key, value in inputs.items() if key != "product"}
    return {
        **rest,
        "products": [
            {
                "style_no": style_no,
                "name": product["name"],
                "brand": "",
                "category": "",
                "color_name": "",
                "image_oss_urls": product["image_oss_urls"],
            }
        ],
    }


def upgrade() -> None:
    connection = op.get_bind()
    # 先校验全部数据再改；任一失败让 Alembic 事务整体回滚。表锁保证读取和回填是同一份需求集合。
    connection.execute(sa.text("LOCK TABLE iclip.tasks IN ACCESS EXCLUSIVE MODE"))
    rows = connection.execute(sa.text("SELECT id, inputs FROM iclip.tasks")).mappings()
    converted = []
    failures = []
    for row in rows:
        try:
            converted.append({"id": row["id"], "inputs": _inputs(row["inputs"])})
        except (ValueError, TypeError) as exc:
            failures.append(f"{row['id']} ({exc})")
    if failures:
        raise RuntimeError("需求单商品列表迁移失败，未修改原数据：" + "; ".join(failures))
    table = sa.table(
        "tasks", sa.column("id", sa.Uuid()), sa.column("inputs", postgresql.JSONB()), schema=SCHEMA
    )
    for row in converted:
        connection.execute(
            table.update().where(table.c.id == row["id"]).values(inputs=row["inputs"])
        )


def downgrade() -> None:
    op.get_bind().execute(sa.text("LOCK TABLE iclip.tasks IN ACCESS EXCLUSIVE MODE"))
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM iclip.tasks)")).scalar_one():
        raise RuntimeError("存在需求单数据，无法无损降级商品列表；请使用迁移前备份恢复")
