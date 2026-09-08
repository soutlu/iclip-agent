"""爆款视频快照的 Postgres 仓储。

表由迁移一次性灌入，运行时只读、不写、不刷新。排序与截断都在数据库里做：换一个
排序维度是换一批样本，不是把同一批本地重排。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from sqlalchemy import (
    BigInteger,
    Column,
    ColumnElement,
    Date,
    Index,
    Integer,
    MetaData,
    Numeric,
    Table,
    Text,
    or_,
    select,
    tuple_,
)
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.inspirations.models import MetricFilters, SortKey, StyleGroup

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

inspiration_videos_table = Table(
    "inspiration_videos",
    metadata_obj,
    Column("video_id", Text, primary_key=True),
    Column("style_raw", Text, nullable=False),
    Column("style_no", Text, nullable=False),
    Column("category_id", Integer, nullable=False),
    Column("category_name", Text, nullable=False),
    Column("brand_code", Text, nullable=False),
    Column("brand_name", Text, nullable=False),
    Column("oss_url", Text, nullable=False),
    Column("posted_date", Date, nullable=True),
    Column("impressions", BigInteger, nullable=False),
    Column("views", BigInteger, nullable=False),
    Column("clicks", BigInteger, nullable=False),
    Column("orders", BigInteger, nullable=False),
    Column("revenue", Numeric, nullable=False),
)

_ROWS = inspiration_videos_table.c

Index("ix_inspiration_videos_style_no", _ROWS.style_no)
Index("ix_inspiration_videos_category_brand", _ROWS.category_id, _ROWS.brand_code)

_SORT_COLUMNS: Final[dict[SortKey, ColumnElement[object]]] = {
    "impressions": _ROWS.impressions,
    "views": _ROWS.views,
    "clicks": _ROWS.clicks,
    "orders": _ROWS.orders,
    "revenue": _ROWS.revenue,
}
"""排序维度到列的映射；调用方给的字符串只作为键，不进 SQL。"""


class PgInspirationVideos:
    """按款号与降级范围读取可下载的爆款视频。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def styles_with_videos(self, style_nos: Sequence[str]) -> frozenset[str]:
        """这批款里哪些自己就有视频。

        刻意不接受 :class:`MetricFilters`：判定的是「这个款有没有视频」，与本次
        请求设了什么门槛无关。
        """

        if not style_nos:
            return frozenset()
        statement = select(_ROWS.style_no).where(_ROWS.style_no.in_(list(style_nos))).distinct()
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).scalars().all()
        return frozenset(rows)

    async def groups_with_videos(
        self, groups: Sequence[StyleGroup]
    ) -> tuple[frozenset[tuple[int, str]], frozenset[int]]:
        """这些品类／品牌组合里，哪些有视频可以拿来当替身。

        一次查询同时回答两级：``(品类, 品牌)`` 与仅按品类。
        """

        if not groups:
            return frozenset(), frozenset()
        statement = (
            select(_ROWS.category_id, _ROWS.brand_code)
            .where(_ROWS.category_id.in_([group.category_id for group in groups]))
            .distinct()
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).all()
        pairs = frozenset((int(category), str(brand)) for category, brand in rows)
        return pairs, frozenset(category for category, _ in pairs)

    async def find_urls(
        self,
        *,
        style_nos: Sequence[str],
        brand_categories: Sequence[StyleGroup],
        categories: Sequence[int],
        filters: MetricFilters,
        sort_by: SortKey,
        limit: int,
    ) -> tuple[str, ...]:
        """取这些范围内表现最好的若干条可下载地址。

        三个范围求并集后一次排序：替身与本款视频在同一个序里比较，与旧实现分批取
        回再内存重排等价，但截断由数据库执行。
        """

        scopes = _scopes(style_nos, brand_categories, categories)
        if scopes is None:
            return ()
        column = _SORT_COLUMNS[sort_by]
        statement = (
            select(_ROWS.oss_url)
            .where(scopes, *_thresholds(filters))
            # video_id 是主键，作为末位键让指标持平时的先后确定。
            .order_by(column.desc(), _ROWS.video_id.asc())
            .limit(limit)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).scalars().all()
        return tuple(rows)


def _scopes(
    style_nos: Sequence[str],
    brand_categories: Sequence[StyleGroup],
    categories: Sequence[int],
) -> ColumnElement[bool] | None:
    """把三级匹配范围合成一个 WHERE 条件；三者皆空时返回 ``None``。"""

    clauses: list[ColumnElement[bool]] = []
    if style_nos:
        clauses.append(_ROWS.style_no.in_(list(style_nos)))
    if brand_categories:
        clauses.append(
            tuple_(_ROWS.category_id, _ROWS.brand_code).in_(
                [(group.category_id, group.brand_code) for group in brand_categories]
            )
        )
    if categories:
        clauses.append(_ROWS.category_id.in_(list(categories)))
    if not clauses:
        return None
    return or_(*clauses) if len(clauses) > 1 else clauses[0]


def _thresholds(filters: MetricFilters) -> list[ColumnElement[bool]]:
    """把设了值的下限转成条件；``None`` 的维度不生成条件。"""

    pairs = (
        (_ROWS.impressions, filters.min_impressions),
        (_ROWS.views, filters.min_views),
        (_ROWS.clicks, filters.min_clicks),
        (_ROWS.orders, filters.min_orders),
        (_ROWS.revenue, filters.min_revenue),
    )
    return [column >= value for column, value in pairs if value is not None]


__all__ = ["DB_SCHEMA", "PgInspirationVideos", "inspiration_videos_table"]
