"""对话用量台账的 Postgres 累加：同一（对话，模型）只有一行，数字往上加。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from sqlalchemy import RowMapping, select
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.harness.usage_ledger_pg import PgConversationUsage, conversation_usage_table
from iclip.platform.transcript.ops import StepUsage
from tests.helpers.pg import truncate_clean


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await truncate_clean(conn, ("agent_runtime.conversation_usage",))
    try:
        yield engine
    finally:
        await engine.dispose()


async def _rows(engine: AsyncEngine) -> dict[tuple[str, str], RowMapping]:
    async with engine.connect() as conn:
        result = await conn.execute(select(conversation_usage_table))
        return {(row["conversation_id"], row["model_name"]): row for row in result.mappings()}


async def test_usage_accumulates_per_conversation_and_model(engine: AsyncEngine) -> None:
    ledger = PgConversationUsage(engine)
    first = StepUsage(input_other=60, output=7, input_cache_read=30, input_cache_creation=10)
    second = StepUsage(input_other=40, output=3, input_cache_read=0, input_cache_creation=5)

    await ledger.add(conversation_id="c1", model_name="m", usage=first)
    await ledger.add(conversation_id="c1", model_name="m", usage=second)
    await ledger.add(conversation_id="c1", model_name="other", usage=first)
    await ledger.add(conversation_id="c2", model_name="m", usage=second)

    rows = await _rows(engine)
    assert set(rows) == {("c1", "m"), ("c1", "other"), ("c2", "m")}
    summed = rows[("c1", "m")]
    assert summed["requests"] == 2
    assert summed["input_tokens"] == 100
    assert summed["cache_read_tokens"] == 30
    assert summed["cache_write_tokens"] == 15
    assert summed["output_tokens"] == 10
    assert summed["first_at"] <= summed["last_at"]
    assert rows[("c2", "m")]["requests"] == 1
