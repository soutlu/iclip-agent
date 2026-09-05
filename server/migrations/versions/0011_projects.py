"""iclip.projects / iclip.task_projects：项目及归属关系

Revision ID: c8e2b47f1a95
Revises: a4d7c9518e63
Create Date: 2026-08-25 16:00:00.000000

需求单与项目为多对多，会话通过可空外键归属单个项目。
删除项目仅解除归属，不删除需求单或会话；会话项目不受需求单项目列表限制。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8e2b47f1a95"
down_revision: str | None = "a4d7c9518e63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), primary_key=True),
        # 保留项目记录，禁止随创建者账号级联删除。
        sa.Column(
            "creator_user_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="restrict"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_projects_updated",
        "projects",
        [sa.text("updated_at DESC")],
        schema=SCHEMA,
    )

    op.create_table(
        "task_projects",
        sa.Column(
            "task_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.tasks.id", ondelete="cascade"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.projects.id", ondelete="cascade"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("task_id", "project_id"),
        schema=SCHEMA,
    )
    # 联合主键仅覆盖 task_id 查询，项目维度需单独索引。
    op.create_index(
        "ix_task_projects_project",
        "task_projects",
        ["project_id"],
        schema=SCHEMA,
    )

    op.add_column(
        "conversations",
        sa.Column(
            "task_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.tasks.id", ondelete="set null"),
            nullable=True,
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "conversations",
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.projects.id", ondelete="set null"),
            nullable=True,
        ),
        schema=SCHEMA,
    )
    # 部分索引排除无归属会话；需求单内按 created_at 排列创作尝试。
    op.create_index(
        "ix_conversations_task",
        "conversations",
        ["task_id", "created_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("task_id IS NOT NULL"),
    )
    op.create_index(
        "ix_conversations_project",
        "conversations",
        ["project_id", sa.text("updated_at DESC")],
        schema=SCHEMA,
        postgresql_where=sa.text("project_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_project", "conversations", schema=SCHEMA)
    op.drop_index("ix_conversations_task", "conversations", schema=SCHEMA)
    op.drop_column("conversations", "project_id", schema=SCHEMA)
    op.drop_column("conversations", "task_id", schema=SCHEMA)
    op.drop_index("ix_task_projects_project", "task_projects", schema=SCHEMA)
    op.drop_table("task_projects", schema=SCHEMA)
    op.drop_index("ix_projects_updated", "projects", schema=SCHEMA)
    op.drop_table("projects", schema=SCHEMA)
