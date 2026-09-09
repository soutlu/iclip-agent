"""媒体生成 HTTP 端点。提交返回 202，此时 pending 记录已落库，Provider 调用由后台执行。

视频那一对端点（提交、查状态）是上游异步接口的镜像，字段 snake_case；其余端点是本系统
自己的，camelCase。"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from iclip.domains.generation.schemas import (
    GenerationEnvelope,
    GenerationsPageOut,
    ImageGenerationIn,
    ImageModelOut,
    ImageModelsOut,
    VideoGenerationIn,
    VideoModelsOut,
    VideoSubmitOut,
    VideoTaskOut,
    generation_out,
    video_task_out,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal, require_permission, resolve_user_name


def create_generations_router(service: GenerationService) -> APIRouter:
    router = APIRouter(prefix="/generations")

    @router.post("/video", response_model=VideoSubmitOut, status_code=202)
    async def submit_video(
        body: VideoGenerationIn,
        principal: Annotated[Principal, Depends(require_permission("generation:submit"))],
    ) -> VideoSubmitOut:
        """提交一次视频生成。请求体照上游异步接口，外加 conversation_id / shot_index / task_id。

        正文可以直接给 ``prompt``，也可以给结构化的 ``shot`` 由服务端拼成 ``prompt``；记录里
        两者都存，``shot`` 不发上游。``user_name``：API key 调用方必填、照收；浏览器会话可
        省略，填登录用户名。
        """

        request = body.model_copy(
            update={"user_name": resolve_user_name(principal, body.user_name)}
        )
        job = await service.submit_video(principal, request)
        return VideoSubmitOut(task_id=job.id)

    @router.post("/image", response_model=GenerationEnvelope, status_code=202)
    async def submit_image(
        body: ImageGenerationIn,
        principal: Annotated[Principal, Depends(require_permission("generation:submit"))],
    ) -> GenerationEnvelope:
        """提交一次图片生成。``userName`` 的规则与视频相同。"""

        request = body.model_copy(
            update={"user_name": resolve_user_name(principal, body.user_name)}
        )
        job = await service.submit_image(principal, request)
        return GenerationEnvelope(generation=generation_out(job))

    @router.get("", response_model=GenerationsPageOut)
    async def list_generations(
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        conversation_id: Annotated[uuid.UUID | None, Query(alias="conversationId")] = None,
        task_id: Annotated[uuid.UUID | None, Query(alias="taskId")] = None,
        kind: Literal["image", "video"] | None = None,
        shot_index: Annotated[int | None, Query(alias="shotIndex", ge=1)] = None,
        frame_number: Annotated[int | None, Query(alias="frameNumber", ge=1)] = None,
        before: uuid.UUID | None = None,
    ) -> GenerationsPageOut:
        """给了 ``conversationId`` / ``taskId`` 就只列那段对话、那张需求单下面的记录，可见性口径不变。"""

        jobs = await service.list_recent(
            principal,
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            shot_index=shot_index,
            frame_number=frame_number,
            task_id=task_id,
            before=before,
        )
        return GenerationsPageOut(items=[generation_out(job) for job in jobs])

    # 带固定路径段的都要声明在 /{job_id} 之前，否则被路径参数吞掉。
    @router.get("/video-models", response_model=VideoModelsOut)
    async def list_video_models(
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
    ) -> VideoModelsOut:
        """接入了哪几个视频模型与默认那个，来自运行配置。"""

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


__all__ = ["create_generations_router"]
