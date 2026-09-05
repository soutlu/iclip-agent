"""镜头素材能力的内存替身：生成、对象存储和视频解析。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from iclip.capabilities.shot_video.ports import (
    ImageChannel,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
)
from iclip.domains.identity.public import Principal

_ASPECT_RATIOS = {"1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
_RESOLUTIONS = {"1k", "2k", "4k"}


@dataclass(frozen=True, slots=True)
class Outcome:
    """预设的生成结果。"""

    status: str = "completed"
    output_url: str | None = "https://cdn.test/out.png"
    error_code: str | None = None
    error_message: str | None = None


@dataclass
class FakeGenerations:
    """按预设顺序返回结果，耗尽后重复最后一条。

    submit 始终返回 pending，get 才返回结果，以覆盖工具的轮询逻辑。
    """

    outcomes: list[Outcome] = field(default_factory=lambda: [Outcome()])
    submitted: list[ImageRequest] = field(default_factory=list[ImageRequest])
    job_ids: list[uuid.UUID] = field(default_factory=list[uuid.UUID])
    polls: int = 0
    jobs: dict[uuid.UUID, tuple[ImageChannel, Outcome]] = field(
        default_factory=dict[uuid.UUID, tuple[ImageChannel, Outcome]]
    )

    async def submit(self, principal: Principal, request: ImageRequest) -> ImageJob:
        _ = principal
        if request.aspect_ratio not in _ASPECT_RATIOS:
            raise InvalidImageRequest(f"aspect_ratio: 不是可选的画幅 {request.aspect_ratio!r}")
        if request.resolution not in _RESOLUTIONS:
            raise InvalidImageRequest(f"resolution: 不是可选的档位 {request.resolution!r}")
        index = len(self.submitted)
        self.submitted.append(request)
        outcome = self.outcomes[min(index, len(self.outcomes) - 1)]
        job_id = uuid.uuid4()
        self.job_ids.append(job_id)
        self.jobs[job_id] = (request.channel, outcome)
        return ImageJob(job_id=job_id, status="pending", channel=request.channel)

    async def get(self, principal: Principal, job_id: uuid.UUID) -> ImageJob:
        _ = principal
        self.polls += 1
        channel, outcome = self.jobs[job_id]
        return ImageJob(
            job_id=job_id,
            status=outcome.status,  # type: ignore[arg-type]
            channel=channel,
            output_url=outcome.output_url if outcome.status == "completed" else None,
            error_code=outcome.error_code,
            error_message=outcome.error_message,
        )

    def channels(self) -> list[str]:
        return [request.channel for request in self.submitted]


@dataclass
class FakeObjects:
    """记录对象 key 并返回固定格式的 URL；设置 error 后写入抛出该异常。"""

    written: dict[str, bytes] = field(default_factory=dict[str, bytes])
    error: Exception | None = None

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        _ = content_type
        if self.error is not None:
            raise self.error
        self.written[object_key] = content
        return f"https://cdn.test/{object_key}"


@dataclass
class FakeUnderstanding:
    """返回预设文档或抛出预设异常。"""

    document: str = "## 4、逐镜拉片表\n**[00:00.000-00:03.800]** 中景……"
    error: Exception | None = None
    calls: list[str] = field(default_factory=list[str])

    async def parse(self, video_url: str) -> str:
        self.calls.append(video_url)
        if self.error is not None:
            raise self.error
        return self.document


__all__ = ["FakeGenerations", "FakeObjects", "FakeUnderstanding", "Outcome"]
