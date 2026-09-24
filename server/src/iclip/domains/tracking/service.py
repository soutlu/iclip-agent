"""埋点用例：按事件名核对主语与资格，以主体的身份落一行。端点权限由路由声明。"""

from __future__ import annotations

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.public import Principal
from iclip.domains.tracking.models import TrackingEvent
from iclip.domains.tracking.repository import TrackingRepository
from iclip.domains.tracking.schemas import TrackingEventIn


class TrackingService:
    def __init__(self, repository: TrackingRepository) -> None:
        self._repository = repository

    async def record(self, principal: Principal, event: TrackingEventIn) -> None:
        """主语缺了或多带是 ``ValidationFailed``；主语不存在或不合格是 ``NotFound``，两者同一句。

        发起用户与 API key 只取主体，发生时刻由数据库给，请求体里不收这些。"""

        # 不写兜底分支：pyright strict 查 match 是否穷尽，事件名表加了新名字这里就报错。
        match event.name:
            case "video.downloaded":
                await self._check_download(event)
        await self._repository.record(
            TrackingEvent(
                name=event.name,
                job_id=event.job_id,
                conversation_id=event.conversation_id,
                user_id=principal.user_id,
                api_key_id=principal.api_key_id,
            )
        )

    async def _check_download(self, event: TrackingEventIn) -> None:
        """下载的主语是一条生成记录；对话由审计经记录推，这里不收。"""

        if event.job_id is None:
            raise ValidationFailed("video.downloaded 必须带 jobId")
        if event.conversation_id is not None:
            raise ValidationFailed("video.downloaded 不带 conversationId")
        if not await self._repository.downloadable(event.job_id):
            raise NotFound("没有这条可下载的视频")


__all__ = ["TrackingService"]
