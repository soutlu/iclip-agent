"""媒体生成 HTTP 端点。提交返回 202，此时 pending 记录已落库，Provider 调用由后台执行。

视频那一对端点（提交、查状态）是上游异步接口的镜像，字段 snake_case；其余端点是本系统
自己的，camelCase。"""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import TypeAdapter, ValidationError

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    ClipIn,
    GenerationEnvelope,
    GenerationKind,
    GenerationsPageOut,
    ImageGenerationIn,
    ImageModelOut,
    ImageModelsOut,
    Metadata,
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
        principal: Annotated[Principal, Depends(require_permission("generation:submit"))],
    ) -> VideoSubmitOut:
        """提交一次视频生成。请求体照上游异步接口，外加 conversation_id / task_id / metadata /
        root_job_id。

        正文可以直接给 ``prompt``，也可以给结构化的 ``shot`` 由服务端拼成 ``prompt``；记录里
        两者都存，``shot`` 不发上游。``user_name``：API key 调用方必填、照收；浏览器会话可
        省略，填登录用户名。``root_job_id`` 只有视频编辑的结果才填：最初那条出片的 id，必须是
        同一段对话里的独立记录。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return VideoSubmitOut(task_id=job.id)

    @router.post("/clips", response_model=GenerationEnvelope, status_code=202)
    async def submit_clip(
        body: ClipIn,
        principal: Annotated[Principal, Depends(require_permission("generation:submit"))],
    ) -> GenerationEnvelope:
        """提交一次本地视频加工：按 ``segments`` 的顺序裁出各段拼成一条，产物存进本系统的桶。

        ``purpose=reference`` 是编辑时切给模型看的参考片段，只能在一条完整视频上裁一段、
        不重编码；``purpose=master`` 是拼出来的成片，一律重编码对齐参数。不经外部服务，
        不计费，也没有 ``userName``。``rootJobId`` 必填：产物是最初那条出片的衍生记录。
        """

        job = await service.submit_clip(principal, body)
        return GenerationEnvelope(generation=generation_out(job))

    @router.post("/image", response_model=GenerationEnvelope, status_code=202)
    async def submit_image(
        body: ImageGenerationIn,
        principal: Annotated[Principal, Depends(require_permission("generation:submit"))],
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
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        conversation_id: Annotated[uuid.UUID | None, Query(alias="conversationId")] = None,
        task_id: Annotated[uuid.UUID | None, Query(alias="taskId")] = None,
        kind: GenerationKind | None = None,
        root_job_id: Annotated[
            uuid.UUID | None,
            Query(alias="rootJobId", description="只列这条出片名下的衍生记录（视频编辑链）"),
        ] = None,
        metadata: Annotated[
            str | None,
            Query(description="JSON 对象；只列坐标包含这些键值的记录，服务端只认其中的 shot"),
        ] = None,
        before: uuid.UUID | None = None,
    ) -> GenerationsPageOut:
        """给了 ``conversationId`` / ``taskId`` / ``rootJobId`` 就只列那段对话、那张需求单、那条出片
        名下的记录，可见性口径不变。

        ``metadata`` 在查询串里是一段 JSON 对象，按包含匹配筛（分镜页拿它按镜头组、按帧查）。
        """

        jobs = await service.list_recent(
            principal,
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            metadata=_metadata_filter(metadata),
            task_id=task_id,
            root_job_id=root_job_id,
            before=before,
        )
        return GenerationsPageOut(items=[generation_out(job) for job in jobs])

    # 带固定路径段的都要声明在 /{job_id} 之前，否则被路径参数吞掉。
    @router.get("/video-models", response_model=VideoModelsOut)
    async def list_video_models(
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
    ) -> VideoModelsOut:
        """接入了哪几个视频模型与默认那个，来自运行配置。

        哪个模型能做视频编辑、怎么触发，由调用方按模型名自己认；服务端不替它拼任何东西。"""

        default, models = service.video_models()
        return VideoModelsOut(default=default, items=list(models))

    @router.get("/image-models", response_model=ImageModelsOut)
    async def list_image_models(
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
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
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
    ) -> VideoTaskOut:
        """视频任务快照，照上游任务查询的形状。只认视频记录，可见性与 ``GET /generations/{id}`` 相同。"""

        return video_task_out(await service.get_video(principal, task_id))

    @router.get("/{job_id}", response_model=GenerationEnvelope)
    async def get_generation(
        job_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
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
