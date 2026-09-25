"""媒体生成 HTTP 端点。提交返回 202，此时 pending 记录已落库，Provider 调用由后台执行。

视频那一对端点（提交、查状态）是上游异步接口的镜像，编辑段转发上游字段、与它们同族，字段都是
snake_case；其余端点是本系统自己的，camelCase。"""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import TypeAdapter, ValidationError

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    GenerationEnvelope,
    GenerationKind,
    GenerationOperation,
    GenerationsPageOut,
    ImageGenerationIn,
    ImageModelOut,
    ImageModelsOut,
    Metadata,
    VideoComposeIn,
    VideoEditIn,
    VideoGenerationIn,
    VideoModelsOut,
    VideoSubmitOut,
    VideoTaskOut,
    generation_out,
    video_task_out,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import (
    ActAs,
    Principal,
    require_permission,
    resolve_user_name,
)
from iclip.platform.http import validation_error_detail
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT


def create_generations_router(service: GenerationService, *, act_as: ActAs) -> APIRouter:
    router = APIRouter(prefix="/generations")

    @router.post("/video", response_model=VideoSubmitOut, status_code=202)
    async def submit_video(
        body: VideoGenerationIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> VideoSubmitOut:
        """提交一次视频生成。请求体照上游异步接口，外加 conversation_id / task_id / shot_index /
        metadata。

        正文可以直接给 ``prompt``，也可以给结构化的 ``shot`` 由服务端拼成 ``prompt``；记录里
        两者都存，``shot`` 不发上游。``shot_index`` 是镜头组编号，落记录的列。``user_name``：
        API key 调用方必填、照收；浏览器会话可省略，填登录用户名。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return VideoSubmitOut(task_id=job.id)

    @router.post("/video-edits", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_edit(
        body: VideoEditIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """在一条成片上改一段：``source_job_id`` 是基底，``range_start_ms`` / ``range_end_ms`` 是区间。

        服务端提交上游前按区间从基底上切参考片段交给模型，记录上的区间随之改记实际切点。基底
        必须是这段对话自己的或继承来的一条已完成成片。``user_name`` 的规则同出片。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video_edit(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return GenerationEnvelope(generation=generation_out(job))

    @router.post("/video-composites", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_composite(
        body: VideoComposeIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """把一条编辑段夹回它的基底，合成同一原作下的新一版成片。不经外部服务。

        ``sourceJobId`` 必须是这段对话自己的或继承来的一条已完成编辑段。``userName`` 的规则同出片。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video_compose(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return GenerationEnvelope(generation=generation_out(job))

    @router.post("/image", response_model=GenerationEnvelope, status_code=202)
    async def submit_image(
        body: ImageGenerationIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """提交一次图片生成。``userName`` 的规则与视频相同。"""

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_image(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return GenerationEnvelope(generation=generation_out(job))

    @router.get("", response_model=GenerationsPageOut)
    async def list_generations(
        principal: Annotated[Principal, require_permission("generation:read")],
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        conversation_id: Annotated[uuid.UUID | None, Query(alias="conversationId")] = None,
        task_id: Annotated[uuid.UUID | None, Query(alias="taskId")] = None,
        shot_index: Annotated[
            int | None,
            Query(alias="shotIndex", ge=1, description="只列这个镜头组编号的视频记录"),
        ] = None,
        kind: GenerationKind | None = None,
        operation: GenerationOperation | None = None,
        root_job_id: Annotated[
            uuid.UUID | None,
            Query(alias="rootJobId", description="只列以这条出片为原作的记录（整条编辑链）"),
        ] = None,
        source_job_id: Annotated[
            uuid.UUID | None,
            Query(alias="sourceJobId", description="只列直接基于这一条的记录"),
        ] = None,
        metadata: Annotated[
            str | None,
            Query(description="JSON 对象；只列 metadata 包含这些键值的记录，服务端不解释其中的键"),
        ] = None,
        before: uuid.UUID | None = None,
    ) -> GenerationsPageOut:
        """给了 ``conversationId`` / ``taskId`` / ``shotIndex`` / ``rootJobId`` / ``sourceJobId`` 就
        只列那段对话、那张需求单下、那个镜号、以那条为原作或直接来源的记录；``kind`` /
        ``operation`` 按种类与操作筛。按对话列时含这段对话经分叉继承的记录（调用方读得到这段
        对话才算），其余可见性口径不变。

        ``metadata`` 在查询串里是一段 JSON 对象，按包含匹配筛（分镜页拿它按镜头组与帧查图片）。
        """

        jobs = await service.list_recent(
            principal,
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            operation=operation,
            metadata=_metadata_filter(metadata),
            task_id=task_id,
            shot_index=shot_index,
            root_job_id=root_job_id,
            source_job_id=source_job_id,
            before=before,
        )
        return GenerationsPageOut(items=[generation_out(job) for job in jobs])

    # 带固定路径段的都要声明在 /{job_id} 之前，否则被路径参数吞掉。
    @router.get("/video-models", response_model=VideoModelsOut)
    async def list_video_models(
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> VideoModelsOut:
        """接入了哪几个视频模型与默认那个，来自运行配置。

        哪个模型能做视频编辑、怎么触发，由调用方按模型名自己认；服务端不替它拼任何东西。"""

        default, models = service.video_models()
        return VideoModelsOut(default=default, items=list(models))

    @router.get("/image-models", response_model=ImageModelsOut)
    async def list_image_models(
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> ImageModelsOut:
        """列出接入了哪几家图片模型与各家支持的档位；受理层照同一份声明校验。"""

        default, models = service.image_models()
        return ImageModelsOut(
            default=default,
            items=[
                ImageModelOut(
                    model=name,
                    label=spec.label,
                    aspect_ratios=spec.aspect_ratios,
                    resolutions=spec.resolutions,
                    channels=spec.channels,
                )
                for name, spec in models
            ],
        )

    @router.get("/video/{task_id}", response_model=VideoTaskOut)
    async def get_video_task(
        task_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> VideoTaskOut:
        """视频任务快照，照上游任务查询的形状。只认调上游的视频记录（出片与编辑段），可见性与
        ``GET /generations/{id}`` 相同。"""

        return video_task_out(await service.get_video(principal, task_id))

    @router.get("/{job_id}", response_model=GenerationEnvelope)
    async def get_generation(
        job_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> GenerationEnvelope:
        job = await service.get(principal, job_id)
        return GenerationEnvelope(generation=generation_out(job))

    return router


_METADATA_FILTER = TypeAdapter(Metadata)


def _metadata_filter(raw: str | None) -> dict[str, Any] | None:
    """查询串里的 ``metadata`` 必须是 JSON 对象，长度与请求体里的同一上限；否则按请求形状错误拒绝。"""

    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise ValidationFailed(f"metadata 不是合法 JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValidationFailed("metadata 必须是 JSON 对象")
    try:
        return _METADATA_FILTER.validate_python(parsed)
    except ValidationError as exc:
        raise ValidationFailed(validation_error_detail(exc.errors())) from exc


__all__ = ["create_generations_router"]
