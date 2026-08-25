"""迁移契约：alembic head 与 ORM 元数据零漂移（表与列名集合）。

断言覆盖 ``iclip`` schema 下的**全部**表，所以每个在这个 schema 里有表的模块都要把
自己的元数据加进 ``_MODULE_METADATA``。少加一个，那张表的迁移漂移就无人看守；而这
张表本身又不能借用别的模块的元数据——那等于让 identity 去持有别人的表。
"""

from __future__ import annotations

from sqlalchemy import MetaData, inspect
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.domains.assets.infra_sql import metadata_obj as assets_metadata
from iclip.domains.conversations.infra_sql import metadata_obj as conversations_metadata
from iclip.domains.generation.infra_sql import metadata_obj as generation_metadata
from iclip.domains.identity.infra_sql import DB_SCHEMA, Base
from iclip.domains.projects.infra_sql import metadata_obj as projects_metadata
from iclip.domains.tasks.infra_sql import metadata_obj as tasks_metadata

_MODULE_METADATA: tuple[MetaData, ...] = (
    Base.metadata,
    assets_metadata,
    conversations_metadata,
    generation_metadata,
    projects_metadata,
    tasks_metadata,
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


def test_upgrade_is_idempotent_at_head(migrated_pg: str) -> None:
    from pathlib import Path

    from alembic import command
    from alembic.config import Config as AlembicConfig

    server_dir = Path(__file__).resolve().parents[3]
    cfg = AlembicConfig(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    cfg.attributes["sqlalchemy_url"] = migrated_pg
    command.upgrade(cfg, "head")  # 已在 head：不抛错、无副作用
