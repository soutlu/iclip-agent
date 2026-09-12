"""媒体生成用例。受理请求时校验、保存 pending 记录并排队，Provider 调用由后台执行。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import structlog

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.generation.models import STATUS_PENDING, GenerationJob
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.queue import GenerationQueue
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    GenerationRequest,
    ImageGenerationIn,
    VideoGenerationIn,
)
from iclip.domains.identity.public import Principal

_logger = structlog.stdlib.get_logger(__name__)

MAX_LIST_LIMIT = 100


class GenerationService:
    """生成请求受理与记录查询。"""

    def __init__(
        self,
        repo: GenerationRepository,
        queue: GenerationQueue,
        *,
        video_provider_name: str,
        video_default_model: str,
        video_allowed_models: tuple[str, ...],
        image_models: Mapping[str, ImageModelSpec],
        image_default_model: str,
    ) -> None:
        """收下装配期确定的模型集合；此层不持有或调用 Provider 实例。

        图片可选哪几家由装配表决定，本层只按它校验并把选中的那家写进记录。"""

        self._repo = repo
        self._queue = queue
        self._video_provider_name = video_provider_name
        self._video_default_model = video_default_model
        self._video_allowed_models = video_allowed_models
        self._image_models = image_models
        self._image_default_model = image_default_model

    async def submit_video(self, principal: Principal, request: VideoGenerationIn) -> GenerationJob:
        """受理一次视频生成。模型必须在允许表里；其余字段原样转发给上游，由它按模型判。"""

        if request.model not in self._video_allowed_models:
            raise ValidationFailed(f"视频生成仅支持模型 {'、'.join(self._video_allowed_models)}")
        _require_user_name(request.user_name)
        return await self._accept(principal, request, provider=self._video_provider_name)

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        """受理一次图片生成。选定哪家、哪个渠道在这里定死，队列等待期间的配置变化不影响它。"""

        _require_user_name(request.user_name)
        settled, model = self._settle_image_model(request)
        return await self._accept(principal, settled, provider=model)

    async def _accept(
        self, principal: Principal, request: GenerationRequest, *, provider: str
    ) -> GenerationJob:
        """保存 pending 记录并排队。入库与排队分属不同事务，排队失败时标记失败并抛出错误。

        两步之间进程中断会留下未排队的 pending 记录，需要人工确认后重新发起。"""

        now = datetime.now(UTC)
        job = GenerationJob(
            id=uuid.uuid4(),
            owner_user_id=principal.user_id,
            api_key_id=principal.api_key_id,
            conversation_id=request.conversation_id,
            metadata=request.metadata,
            task_id=request.task_id,
            kind=request.kind,
            provider=provider,
            request=request,
            status=STATUS_PENDING,
            provider_task_id=None,
            provider_status=None,
            provider_snapshot=None,
            output_url=None,
            error_code=None,
            error_message=None,
            # 仓储使用数据库 now() 覆盖时间占位值。
            created_at=now,
            updated_at=now,
            submitted_at=None,
            finished_at=None,
        )
        created = await self._repo.create(job)
        try:
            await self._queue.enqueue_submit(created)
        except Exception as exc:
            await self._repo.mark_failed(
                created.id,
                error_code="QUEUE_DEFER_FAILED",
                error_message=f"受理了但没能排进队列，请重新发起：{exc}",
            )
            _logger.exception("生成任务排队失败", job_id=created.id)
            raise
        return created

    def _settle_image_model(self, request: ImageGenerationIn) -> tuple[ImageGenerationIn, str]:
        """把这次要用哪家、哪个渠道定下来写进请求，并把选定的那家单独交回去当 provider 列。

        画幅与分辨率的全局枚举是各家的并集，各家真正支持的范围由它自己声明；在这里拦，
        才不会变成一次已排队、已付费的失败。"""

        model = request.model or self._image_default_model
        spec = self._image_models.get(model)
        if spec is None:
            raise ValidationFailed(f"图片生成仅支持模型 {'、'.join(self._image_models)}")
        if request.aspect_ratio not in spec.aspect_ratios:
            raise ValidationFailed(
                f"{model} 不支持画幅 {request.aspect_ratio}，可选 {'、'.join(spec.aspect_ratios)}"
            )
        if request.resolution not in spec.resolutions:
            raise ValidationFailed(
                f"{model} 不支持分辨率 {request.resolution}，可选 {'、'.join(spec.resolutions)}"
            )
        if request.channel is not None and not spec.channels:
            raise ValidationFailed(f"{model} 没有渠道这个轴，不要传 channel")
        if request.channel is not None and request.channel not in spec.channels:
            raise ValidationFailed(
                f"{model} 不支持渠道 {request.channel}，可选 {'、'.join(spec.channels)}"
            )
        # 受理时固定，队列等待期间的配置变化不能改变这次请求的选择。
        channel = request.channel or (spec.channels[0] if spec.channels else None)
        return request.model_copy(update={"model": model, "channel": channel}), model

    def video_models(self) -> tuple[str, tuple[str, ...]]:
        """默认视频模型与允许表，按配置声明顺序。"""

        return self._video_default_model, self._video_allowed_models

    def image_models(self) -> tuple[str, tuple[tuple[str, ImageModelSpec], ...]]:
        """默认模型与装配表里那几家的声明，按声明顺序。"""

        return self._image_default_model, tuple(self._image_models.items())

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        """读取可见生成记录，不可见时返回 NotFound。"""

        return await self._repo.get(job_id, owner=_owner_scope(principal))

    async def get_video(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        """视频任务查询只认视频记录：拿图片的 id 来查与不存在同样是 404。"""

        job = await self.get(principal, job_id)
        if job.kind != KIND_VIDEO:
            raise NotFound(f"没有这个视频任务: {job_id}")
        return job

    async def list_recent(
        self,
        principal: Principal,
        *,
        limit: int = 20,
        conversation_id: uuid.UUID | None = None,
        kind: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
    ) -> tuple[GenerationJob, ...]:
        """按时间倒序返回可见记录；归属筛选只收窄，不扩大属主可见范围。"""

        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")
        return await self._repo.list_for_owner(
            owner=_owner_scope(principal),
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            metadata=metadata,
            task_id=task_id,
            before=before,
        )


def _require_user_name(user_name: str | None) -> None:
    """HTTP 边界与工具都先按主体定好了名字；到这儿还空着就是漏了一条路，照实拒绝。"""

    if user_name is None:
        raise ValidationFailed("user_name 必填")


def _owner_scope(principal: Principal) -> uuid.UUID | None:
    """治理者（``users:manage``）看全部，其余人只看自己的。"""

    if principal.has("users:manage"):
        return None
    return principal.user_id


__all__ = ["MAX_LIST_LIMIT", "GenerationService"]
