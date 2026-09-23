"""媒体生成用例。受理请求时校验、保存 pending 记录并排队，Provider 调用由后台执行。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

import structlog

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.generation.models import STATUS_PENDING, GenerationJob, InFlightPhase
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.queue import GenerationQueue
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    ClipIn,
    GenerationKind,
    GenerationRequest,
    ImageGenerationIn,
    VideoGenerationIn,
)
from iclip.domains.identity.public import ACT_AS_PERMISSION, Principal
from iclip.platform.paging import check_limit

_logger = structlog.stdlib.get_logger(__name__)

ClearCompletion = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]
"""按 (对话 id, 属主) 取消那段对话的收尾标记；实现由组合根注入，本域不认识对话表。"""


class GenerationService:
    """生成请求受理与记录查询。"""

    def __init__(
        self,
        repo: GenerationRepository,
        queue: GenerationQueue,
        *,
        video_provider_name: str,
        clip_provider_name: str,
        video_default_model: str,
        video_allowed_models: tuple[str, ...],
        image_models: Mapping[str, ImageModelSpec],
        image_default_model: str,
        clear_completion: ClearCompletion,
    ) -> None:
        """收下装配期确定的模型集合；此层不持有或调用 Provider 实例。

        图片可选哪几家由装配表决定，本层只按它校验并把选中的那家写进记录。"""

        self._repo = repo
        self._queue = queue
        self._video_provider_name = video_provider_name
        self._clip_provider_name = clip_provider_name
        self._video_default_model = video_default_model
        self._video_allowed_models = video_allowed_models
        self._image_models = image_models
        self._image_default_model = image_default_model
        self._clear_completion = clear_completion

    async def copy_to_fork(
        self,
        *,
        source_conversation_id: uuid.UUID,
        target_conversation_id: uuid.UUID,
        owner: uuid.UUID,
        task_id: uuid.UUID | None,
    ) -> int:
        """把源对话已出片的记录复制到副本名下，返回复制了几条。

        不收 Principal：授权在对话域做完了——能分叉就说明这个人读得到源对话，也读得到
        它的出片记录。复制只落记录，不排队、不调 Provider、不产生对外调用。"""

        return await self._repo.copy_completed_to_fork(
            source_conversation_id=source_conversation_id,
            target_conversation_id=target_conversation_id,
            owner=owner,
            task_id=task_id,
        )

    async def submit_video(self, principal: Principal, request: VideoGenerationIn) -> GenerationJob:
        """受理一次视频生成。模型必须在允许表里；其余字段原样转发给上游，由它按模型判。"""

        if request.model not in self._video_allowed_models:
            raise ValidationFailed(f"视频生成仅支持模型 {'、'.join(self._video_allowed_models)}")
        _require_user_name(request.user_name)
        await self._check_root(principal, request)
        return await self._accept(principal, request, provider=self._video_provider_name)

    async def submit_clip(self, principal: Principal, request: ClipIn) -> GenerationJob:
        """受理一次本地视频加工。不经外部服务、不计费，门槛只有原作号要给且对得上。"""

        if request.root_job_id is None:
            raise ValidationFailed("rootJobId 必填：本地加工的产物一律是某条出片的衍生记录")
        await self._check_root(principal, request)
        return await self._accept(principal, request, provider=self._clip_provider_name)

    async def _check_root(self, principal: Principal, request: GenerationRequest) -> None:
        """原作号必须指向同一段对话里的一条独立记录，链才只有一层。

        先按主体可见范围读：生成记录的 ``conversation_id`` 只是标签、不按对话验属主，直接按
        id 查会让人把衍生记录挂到别人的出片上。三种不满足给同一句，不区分不存在与不可见。"""

        if request.root_job_id is None:
            return
        try:
            root = await self._repo.get(request.root_job_id, owner=_owner_scope(principal))
        except NotFound:
            root = None
        if (
            root is None
            or root.conversation_id != request.conversation_id
            or root.root_job_id is not None
        ):
            raise ValidationFailed("原作号不是这段对话里的一条独立记录")

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        """受理一次图片生成。选定哪家、哪个渠道在这里定死，队列等待期间的配置变化不影响它。"""

        _require_user_name(request.user_name)
        await self._check_root(principal, request)
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
            root_job_id=request.root_job_id,
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
        await self._note_conversation_active(created)
        return created

    async def _note_conversation_active(self, job: GenerationJob) -> None:
        """出片提交就是又在这段对话里开工了，收尾标记不该留着。

        归档标签指向的对话不校验，对话域按属主自己判；这一步失败只记日志——受理已经成立，
        不能因为一个标记回滚。"""

        if job.conversation_id is None:
            return
        try:
            await self._clear_completion(job.conversation_id, job.owner_user_id)
        except Exception:
            _logger.warning(
                "取消对话收尾标记失败", job_id=job.id, conversation_id=job.conversation_id
            )

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

    async def in_flight_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID], *, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        """给对话侧栏用：这些对话下还没跑完的某类任务各到哪一步。可见性由对话那边判过，这里不再按属主筛。"""

        return await self._repo.in_flight_by_conversation(conversation_ids, kind=kind)

    async def list_recent(
        self,
        principal: Principal,
        *,
        limit: int = 20,
        conversation_id: uuid.UUID | None = None,
        kind: GenerationKind | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        root_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
    ) -> tuple[GenerationJob, ...]:
        """按时间倒序返回可见记录；归属筛选只收窄，不扩大属主可见范围。"""

        check_limit(limit)
        return await self._repo.list_for_owner(
            owner=_owner_scope(principal),
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            metadata=metadata,
            task_id=task_id,
            root_job_id=root_job_id,
            before=before,
        )


def _require_user_name(user_name: str | None) -> None:
    """HTTP 边界与工具都先按主体定好了名字；到这儿还空着就是漏了一条路，照实拒绝。"""

    if user_name is None:
        raise ValidationFailed("user_name 必填")


def _owner_scope(principal: Principal) -> uuid.UUID | None:
    """治理者（``users:manage``）与替人办事的钥匙（``users:act_as``）看全部，其余人只看自己的。"""

    if principal.has("users:manage"):
        return None
    if principal.kind == "api_key" and principal.has(ACT_AS_PERMISSION):
        return None
    return principal.user_id


__all__ = ["GenerationService"]
