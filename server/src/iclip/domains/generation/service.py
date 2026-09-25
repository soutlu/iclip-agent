"""媒体生成用例。受理请求时校验、保存 pending 记录并排队，Provider 调用由后台执行。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_PENDING,
    GenerationJob,
    InFlightPhase,
    Inheritance,
    inherited_through,
)
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.queue import GenerationQueue
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_GENERATE,
    ComposeSegment,
    GenerationKind,
    GenerationOperation,
    GenerationRequest,
    ImageGenerationIn,
    VideoComposeIn,
    VideoComposeRequest,
    VideoEditIn,
    VideoGenerationIn,
)
from iclip.domains.identity.public import Principal, visible_owner_incl_act_as
from iclip.platform.paging import check_limit

_logger = structlog.stdlib.get_logger(__name__)

ClearCompletion = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]
"""按 (对话 id, 属主) 取消那段对话的收尾标记；实现由组合根注入，本域不认识对话表。"""


class ConversationLineage(Protocol):
    """按对话读记录时要知道的两件对话事实；实现由组合根接到对话域上，本域不认识对话表。"""

    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance:
        """这段对话的继承边界对，近的祖先在前；不是分叉来的给空。祖先删没删都照走。"""
        ...

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        """主体读不读得到这段对话，与对话域读路径同一口径。"""
        ...


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
        lineage: ConversationLineage,
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
        self._lineage = lineage

    async def _inheritance(
        self, principal: Principal, conversation_id: uuid.UUID | None
    ) -> Inheritance:
        """主体读得到这段对话时，它经分叉继承的边界对；没给对话或读不到就是空，只剩属主口径。

        读不到不报错：生成记录的对话归属只是标签，按对话列记录从来不要求读得到那段对话。"""

        if conversation_id is None or not await self._lineage.readable(principal, conversation_id):
            return ()
        return await self._lineage.ancestry(conversation_id)

    async def submit_video(self, principal: Principal, request: VideoGenerationIn) -> GenerationJob:
        """受理一次视频生成。模型必须在允许表里；其余字段原样转发给上游，由它按模型判。"""

        self._require_video_model(request.model)
        _require_user_name(request.user_name)
        return await self._accept(
            principal,
            request,
            provider=self._video_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
        )

    async def submit_video_edit(self, principal: Principal, request: VideoEditIn) -> GenerationJob:
        """受理一次编辑段：在一条成片上改一段，走视频上游。

        基底必须是这段对话看得到的一条已完成成片；原作随基底，基底是出片就是它自己。区间先按
        请求记，提交上游前服务端切参考片段时改记实际切点。落库的请求不带参考视频，片段地址只进
        发给上游的那一次请求。"""

        self._require_video_model(request.model)
        _require_user_name(request.user_name)
        base = await self._check_source(principal, request.source_job_id, request.conversation_id)
        if not _is_completed_master(base):
            raise ValidationFailed("基底必须是一条已完成的成片")
        forwarded = VideoGenerationIn(
            model=request.model,
            prompt=request.prompt,
            user_name=request.user_name,
            reference_image_urls=request.reference_image_urls,
            seconds=request.seconds,
            provider_options=request.provider_options,
        )
        return await self._accept(
            principal,
            forwarded,
            provider=self._video_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            root_job_id=base.root_job_id or base.id,
            source_job_id=base.id,
            range_start_ms=request.range_start_ms,
            range_end_ms=request.range_end_ms,
        )

    async def submit_video_compose(
        self, principal: Principal, request: VideoComposeIn
    ) -> GenerationJob:
        """受理一次合成：把编辑段夹回它的基底，拼成同一原作下的新一版成片。

        段按编辑段上记的实际区间算：基底从头到起点（起点为 0 时没有这段）、编辑段产物整条、
        基底从终点到结尾。后两段取到结尾，执行方按下载下来的素材补齐。不经外部服务。"""

        _require_user_name(request.user_name)
        edit = await self._check_source(principal, request.source_job_id, request.conversation_id)
        if not _is_finished_edit(edit) or edit.output_url is None or edit.source_job_id is None:
            raise ValidationFailed("来源必须是一条已完成的编辑段")
        # 组合约束保证编辑段的区间齐全；到这儿为空说明持久化状态坏了。
        if edit.range_start_ms is None or edit.range_end_ms is None:
            raise RuntimeError(f"编辑段 {edit.id} 没有区间")
        base = await self._repo.get(edit.source_job_id, owner=None)
        if base.output_url is None:
            raise ValidationFailed("编辑段的基底没有产物地址，合成不了")
        segments = [
            *(
                [ComposeSegment(url=base.output_url, start=0, end=edit.range_start_ms / 1000)]
                if edit.range_start_ms > 0
                else []
            ),
            ComposeSegment(url=edit.output_url, start=0),
            ComposeSegment(url=base.output_url, start=edit.range_end_ms / 1000),
        ]
        return await self._accept(
            principal,
            VideoComposeRequest(segments=segments, user_name=request.user_name),
            provider=self._clip_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            root_job_id=edit.root_job_id,
            source_job_id=edit.id,
        )

    async def _check_source(
        self, principal: Principal, source_id: uuid.UUID, conversation_id: uuid.UUID | None
    ) -> GenerationJob:
        """来源必须是这段对话自己的或它继承的一条记录，返回那条记录。

        先按主体可见范围读：生成记录的 ``conversation_id`` 只是标签、不按对话验属主，直接按
        id 查会让人在别人的片上接着剪；继承的那部分只在主体读得到这段对话时才算。按属主读得到
        的也可能是祖先对话里分叉之后才完成的，那不归这段对话，要再判一次。不存在、不可见、
        不在范围内给同一句，不区分存在性；角色与状态对不对由调用方判。"""

        inheritance = await self._inheritance(principal, conversation_id)
        try:
            source = await self._repo.get(
                source_id, owner=visible_owner_incl_act_as(principal), inherited=inheritance
            )
        except NotFound:
            source = None
        if source is None or (
            source.conversation_id != conversation_id and not inherited_through(source, inheritance)
        ):
            raise ValidationFailed("来源不是这段对话自己的或继承来的一条记录")
        return source

    def _require_video_model(self, model: str) -> None:
        if model not in self._video_allowed_models:
            raise ValidationFailed(f"视频生成仅支持模型 {'、'.join(self._video_allowed_models)}")

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        """受理一次图片生成。选定哪家、哪个渠道在这里定死，队列等待期间的配置变化不影响它。"""

        _require_user_name(request.user_name)
        settled, model = self._settle_image_model(request)
        return await self._accept(
            principal,
            settled,
            provider=model,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
        )

    async def _accept(
        self,
        principal: Principal,
        request: GenerationRequest,
        *,
        provider: str,
        conversation_id: uuid.UUID | None,
        task_id: uuid.UUID | None,
        metadata: dict[str, Any] | None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        range_start_ms: int | None = None,
        range_end_ms: int | None = None,
    ) -> GenerationJob:
        """保存 pending 记录并排队。入库与排队分属不同事务，排队失败时标记失败并抛出错误。

        kind 与 operation 随落库请求的类型定；归属、来源与区间由各入口显式给，不从请求上抄。
        两步之间进程中断会留下未排队的 pending 记录，需要人工确认后重新发起。"""

        now = datetime.now(UTC)
        job = GenerationJob(
            id=uuid.uuid4(),
            owner_user_id=principal.user_id,
            api_key_id=principal.api_key_id,
            conversation_id=conversation_id,
            metadata=metadata,
            task_id=task_id,
            root_job_id=root_job_id,
            source_job_id=source_job_id,
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
            kind=request.kind,
            operation=request.operation,
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
                "取消对话收尾标记失败",
                job_id=job.id,
                conversation_id=job.conversation_id,
                exc_info=True,
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

        return await self._repo.get(job_id, owner=visible_owner_incl_act_as(principal))

    async def get_video(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        """视频任务查询只认调上游的视频记录（出片与编辑段）：图片与合成的 id 与不存在同样是 404。

        合成不经上游、没有水印版地址，套不进上游任务查询的形状。"""

        job = await self.get(principal, job_id)
        if job.kind != KIND_VIDEO or job.operation != OPERATION_GENERATE:
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
        operation: GenerationOperation | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
    ) -> tuple[GenerationJob, ...]:
        """按时间倒序返回可见记录；归属筛选只收窄，不扩大属主可见范围。

        唯一的例外是按对话列：主体读得到那段对话时，连它经分叉继承的记录一起列出，不看属主。"""

        check_limit(limit)
        return await self._repo.list_for_owner(
            owner=visible_owner_incl_act_as(principal),
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            operation=operation,
            metadata=metadata,
            task_id=task_id,
            root_job_id=root_job_id,
            source_job_id=source_job_id,
            before=before,
            inherited=await self._inheritance(principal, conversation_id),
        )


def _is_completed_master(job: GenerationJob) -> bool:
    """成片：一条已完成、有地址的视频，是出片（没有来源的 generate）或合成。"""

    return (
        job.kind == KIND_VIDEO
        and job.status == STATUS_COMPLETED
        and job.output_url is not None
        and (
            job.operation == OPERATION_COMPOSE
            or (job.operation == OPERATION_GENERATE and job.source_job_id is None)
        )
    )


def _is_finished_edit(job: GenerationJob) -> bool:
    """已完成的编辑段：有来源的视频 generate。"""

    return (
        job.kind == KIND_VIDEO
        and job.operation == OPERATION_GENERATE
        and job.source_job_id is not None
        and job.status == STATUS_COMPLETED
    )


def _require_user_name(user_name: str | None) -> None:
    """HTTP 边界与工具都先按主体定好了名字；到这儿还空着就是漏了一条路，照实拒绝。"""

    if user_name is None:
        raise ValidationFailed("user_name 必填")


__all__ = ["ConversationLineage", "GenerationService"]
