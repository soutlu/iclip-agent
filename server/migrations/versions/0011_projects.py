"""iclip.projects / iclip.task_projects：项目，以及单与会话往项目里的归属

Revision ID: c8e2b47f1a95
Revises: a4d7c9518e63
Create Date: 2026-08-25 16:00:00.000000

项目是归拢用的口袋。一张需求单可以同时算在几个项目里（既是春季童鞋，也是北美站的
活），所以那一头是连接表；一段会话只待在一个口袋里，所以那一头是会话表上的一列。

两处归属都可以为空，也都用 SET NULL / CASCADE 而不是级联删行：**删掉一个项目不该带
走任何人的会话，也不该带走需求单**——口袋没了，东西还在。

会话上那一列不校验「必须是它那张单挂过的项目」：单挂的项目只是新建会话时的默认值，
不是围栏。管了反而要多定一条规则——单后来取消了某个项目，已经放进去的老会话算不算
违规。
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
        # 同 tasks.creator_user_id：项目是记录在案的东西，不该跟着建它的那个账号一起
        # 消失。账号目前只停用不删除，所以 restrict 挡不住任何正常路径。
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
        # 两列即主键：同一张单挂同一个项目两遍，在表结构上就放不下。
        sa.PrimaryKeyConstraint("task_id", "project_id"),
        schema=SCHEMA,
    )
    # 主键首列是 task_id，「这张单挂了哪些项目」够用了；反向那问「这个项目里有哪些
    # 单」得自己一个索引。
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
    # 两个索引都带 WHERE：没挂单、没进项目的会话是多数，不该占索引。
    # 单那条按 created_at 升序——「这张单的第几次尝试」就是按它排出来的。
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
