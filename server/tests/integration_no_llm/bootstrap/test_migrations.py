"""比较 Alembic head 与 iclip schema 的 ORM 表、列集合。

_MODULE_METADATA 必须包含所有自有表模块的元数据，确保迁移对账完整。
"""

from __future__ import annotations

from sqlalchemy import MetaData, inspect
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.domains.assets.infra_sql import metadata_obj as assets_metadata
from iclip.domains.collections.infra_sql import metadata_obj as collections_metadata
from iclip.domains.conversations.infra_sql import metadata_obj as conversations_metadata
from iclip.domains.generation.infra_sql import metadata_obj as generation_metadata
from iclip.domains.identity.infra_sql import DB_SCHEMA, Base
from iclip.domains.tasks.infra_sql import metadata_obj as tasks_metadata

_MODULE_METADATA: tuple[MetaData, ...] = (
    Base.metadata,
    assets_metadata,
    conversations_metadata,
    generation_metadata,
    collections_metadata,
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
    command.upgrade(cfg, "head")
