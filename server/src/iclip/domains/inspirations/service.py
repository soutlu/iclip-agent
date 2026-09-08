"""按款搜爆款视频：本款优先，没有就按品牌与品类逐级放宽。"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from iclip.domains.inspirations.infra_sql import PgInspirationVideos
from iclip.domains.inspirations.models import (
    MatchLevel,
    MetricFilters,
    SortKey,
    StyleGroup,
    StyleMatch,
    VideoSearchResult,
)
from iclip.domains.products.public import StyleDirectory, StyleGrouping


class NoStyleDirectory:
    """未配置产品资料库时的款目录：任何款都归属不明。

    没有品类与品牌就圈选不出同类款，降级整级失效，未命中的款一律 ``none``。这是
    实名的能力缺失，不是查不到——组合根在装配时会明确告警。
    """

    async def resolve(self, style_nos: Sequence[str]) -> Mapping[str, StyleGrouping]:
        return {}


class InspirationService:
    """本款 → 同品牌同类目 → 同类目，逐级为没有视频的款挑替身。"""

    def __init__(self, videos: PgInspirationVideos, styles: StyleDirectory) -> None:
        self._videos = videos
        self._styles = styles

    async def search_videos(
        self,
        style_nos: Sequence[str],
        *,
        filters: MetricFilters,
        sort_by: SortKey,
        limit: int,
    ) -> VideoSearchResult:
        wanted = _unique(style_nos)
        exact = await self._videos.styles_with_videos(wanted)
        unresolved = tuple(style_no for style_no in wanted if style_no not in exact)

        levels: dict[str, MatchLevel] = {style_no: "exact" for style_no in exact}
        brand_categories: list[StyleGroup] = []
        categories: list[int] = []
        if unresolved:
            levels |= await self._fall_back(unresolved, brand_categories, categories)

        urls = await self._videos.find_urls(
            style_nos=sorted(exact),
            brand_categories=_unique(brand_categories),
            categories=_unique(categories),
            filters=filters,
            sort_by=sort_by,
            limit=limit,
        )
        return VideoSearchResult(
            oss_urls=urls,
            matches=tuple(
                StyleMatch(style_no=style_no, match_level=levels.get(style_no, "none"))
                for style_no in wanted
            ),
        )

    async def _fall_back(
        self,
        unresolved: Sequence[str],
        brand_categories: list[StyleGroup],
        categories: list[int],
    ) -> dict[str, MatchLevel]:
        """为没有视频的款逐级挑替身，并把选中的范围累加到查询作用域。

        入参款在产品资料中查不到，或它所在的品类里没有任何视频，都落到 ``none``：
        这不是错误，只是这次没有可用的参考。
        """

        grouping = await self._styles.resolve(unresolved)
        groups = {
            style_no: StyleGroup(category_id=item.category_id, brand_code=item.brand_code)
            for style_no, item in grouping.items()
        }
        pairs, with_videos = await self._videos.groups_with_videos(_unique(groups.values()))

        levels: dict[str, MatchLevel] = {}
        for style_no in unresolved:
            group = groups.get(style_no)
            if group is None:
                levels[style_no] = "none"
                continue
            if (group.category_id, group.brand_code) in pairs:
                levels[style_no] = "sameBrandCategory"
                brand_categories.append(group)
            elif group.category_id in with_videos:
                levels[style_no] = "sameCategory"
                categories.append(group.category_id)
            else:
                levels[style_no] = "none"
        return levels


def _unique[ItemT](items: Iterable[ItemT]) -> tuple[ItemT, ...]:
    """保序去重。"""

    return tuple(dict.fromkeys(items))


__all__ = ["InspirationService", "NoStyleDirectory"]
