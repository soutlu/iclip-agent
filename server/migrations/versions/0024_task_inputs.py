"""统一需求单创作输入，保留旧字段内容。

Revision ID: 7c8e15d2b604
Revises: 5e2a9c47b013
Create Date: 2026-09-06 11:00:00.000000
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any
from urllib.parse import urlsplit

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7c8e15d2b604"
down_revision: str | None = "5e2a9c47b013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"

_BRIEF_TEXT = {
    "theme": "主题",
    "purpose": "目的",
    "audience": "受众",
    "selling": "卖点",
    "scene": "场景",
    "department": "部门",
    "requester": "需求方",
    "language": "语言",
    "color": "颜色",
}
_MAPPED_BRIEF = {
    "platform",
    "videoType",
    "contentType",
    "ratio",
    "durationSeconds",
    "requirementDescription",
    "referenceImages",
    "referenceVideos",
    "styleNos",
}


def _text(data: dict[str, Any], key: str, *, limit: int | None = 200) -> str:
    value = data.get(key, "")
    if not isinstance(value, str) or (limit is not None and len(value) > limit):
        raise ValueError(f"{key} 的字符串类型或长度非法")
    return value


def _urls(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key, [])
    if not isinstance(value, list) or len(value) > 16:
        raise ValueError(f"{key} 必须是至多 16 项的数组")
    for url in value:
        _url(url)
    return value


def _url(value: Any) -> None:
    if not isinstance(value, str):
        raise ValueError("素材 URL 必须是字符串")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("素材 URL 必须是 HTTP(S) 地址")


def _present(value: Any) -> bool:
    return value is not None and value != "" and value != [] and value != {}


def _display(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _inputs(style: Any, brief: Any) -> dict[str, Any]:
    """迁移版本自含映射规则，避免以后领域模型变化影响历史迁移。"""

    if not isinstance(style, dict) or not isinstance(brief, dict):
        raise ValueError("style 和 brief 必须是对象")
    style_no = _text(style, "styleNo", limit=64)
    if not style_no.strip():
        raise ValueError("商品款号不能为空")
    preview = _text(style, "previewImageUrl", limit=None)
    if preview:
        _url(preview)
    duration = brief.get("durationSeconds")
    if duration is not None and (type(duration) is not int or not 3 <= duration <= 50):
        raise ValueError("时长必须为空或 3–50 的整数")
    ratio = brief.get("ratio")
    if ratio is not None and ratio not in {"1:1", "3:4", "4:3", "9:16", "16:9", "21:9"}:
        raise ValueError("画幅不在支持范围内")
    images = _urls(brief, "referenceImages")
    videos = _urls(brief, "referenceVideos")
    style_nos = brief.get("styleNos", [])
    if not isinstance(style_nos, list) or len(style_nos) > 20:
        raise ValueError("styleNos 必须是至多 20 项的数组")
    if any(
        not isinstance(value, str) or not value.strip() or len(value) > 64 for value in style_nos
    ):
        raise ValueError("styleNos 中款号非法")

    description = _text(brief, "requirementDescription", limit=4000)
    sections = [description] if description else []
    for field, label in _BRIEF_TEXT.items():
        value = _text(brief, field)
        if value:
            sections.append(f"{label}：{value}")
    for field, label in (("brand", "品牌"), ("category", "品类")):
        value = _text(style, field)
        if value:
            sections.append(f"{label}：{value}")
    if images:
        sections.append("未分类参考图片：\n" + "\n".join(images))
    extra_styles = list(style_nos)
    if extra_styles and extra_styles[0] == style_no:
        extra_styles = extra_styles[1:]
    if extra_styles:
        sections.append("额外款号：\n" + "\n".join(extra_styles))
    if len(videos) > 1:
        sections.append("额外参考视频：\n" + "\n".join(videos[1:]))
    for source, data, known in (
        ("style", style, {"styleNo", "brand", "category", "previewImageUrl"}),
        ("brief", brief, _MAPPED_BRIEF | set(_BRIEF_TEXT)),
    ):
        for field, value in data.items():
            if field not in known and _present(value):
                sections.append(f"补充信息（{source}.{field}）：{_display(value)}")
    creative_requirement = "\n\n".join(sections)
    if len(creative_requirement) > 4000:
        raise ValueError("合并后的创作要求超过 4000 字符，须先整理原需求内容")
    return {
        "video_spec": {
            "platform": _text(brief, "platform"),
            "video_type": _text(brief, "videoType"),
            "content_type": _text(brief, "contentType"),
            "resolution": "",
            "aspect_ratio": ratio,
            "duration_seconds": duration,
        },
        "product": {
            "style_no": style_no,
            "name": "",
            "image_oss_urls": [preview] if preview else [],
        },
        "reference_image_oss_urls": {"model": [], "outfit": [], "prop": []},
        "reference_video_oss_url": videos[0] if videos else None,
        "creative_requirement": creative_requirement,
    }


def upgrade() -> None:
    connection = op.get_bind()
    # 先校验全部数据再改列；任一失败让 Alembic 事务整体回滚。
    # 表锁同时阻止并发新增与更新，保证读取和回填是同一份需求集合。
    connection.execute(sa.text("LOCK TABLE iclip.tasks IN ACCESS EXCLUSIVE MODE"))
    rows = connection.execute(sa.text("SELECT id, style, brief FROM iclip.tasks")).mappings()
    converted = []
    failures = []
    for row in rows:
        try:
            converted.append({"id": row["id"], "inputs": _inputs(row["style"], row["brief"])})
        except (ValueError, TypeError) as exc:
            failures.append(f"{row['id']} ({exc})")
    if failures:
        raise RuntimeError("需求单 inputs 迁移失败，未修改原数据：" + "; ".join(failures))
    op.add_column("tasks", sa.Column("inputs", postgresql.JSONB(), nullable=True), schema=SCHEMA)
    table = sa.table(
        "tasks", sa.column("id", sa.Uuid()), sa.column("inputs", postgresql.JSONB()), schema=SCHEMA
    )
    for row in converted:
        connection.execute(
            table.update().where(table.c.id == row["id"]).values(inputs=row["inputs"])
        )
    op.alter_column("tasks", "inputs", nullable=False, schema=SCHEMA)
    op.create_check_constraint(
        "tasks_inputs_object_check", "tasks", "jsonb_typeof(inputs) = 'object'", schema=SCHEMA
    )
    op.drop_constraint("tasks_style_object_check", "tasks", schema=SCHEMA, type_="check")
    op.drop_constraint("tasks_brief_object_check", "tasks", schema=SCHEMA, type_="check")
    op.drop_column("tasks", "style", schema=SCHEMA)
    op.drop_column("tasks", "brief", schema=SCHEMA)


def downgrade() -> None:
    op.get_bind().execute(sa.text("LOCK TABLE iclip.tasks IN ACCESS EXCLUSIVE MODE"))
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM iclip.tasks)")).scalar_one():
        raise RuntimeError("存在需求单数据，无法无损降级 inputs；请使用迁移前备份恢复")
    op.add_column("tasks", sa.Column("style", postgresql.JSONB(), nullable=False), schema=SCHEMA)
    op.add_column("tasks", sa.Column("brief", postgresql.JSONB(), nullable=False), schema=SCHEMA)
    op.create_check_constraint(
        "tasks_style_object_check", "tasks", "jsonb_typeof(style) = 'object'", schema=SCHEMA
    )
    op.create_check_constraint(
        "tasks_brief_object_check", "tasks", "jsonb_typeof(brief) = 'object'", schema=SCHEMA
    )
    op.drop_constraint("tasks_inputs_object_check", "tasks", schema=SCHEMA, type_="check")
    op.drop_column("tasks", "inputs", schema=SCHEMA)
