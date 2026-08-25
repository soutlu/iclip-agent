"""镜头素材能力的进程内替身：出图、对象存储、视频拆解。

三个都窄到能手写：能力包对外只要「提交/查一次生成」「把字节放到公网地址」「把
视频换成一份文档」。所以工具面的语义不需要真的生成后端、真的 OSS 或真的模型就
能验。
"""

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
    """一次生成脚本化的结局。"""

    status: str = "completed"
    output_url: str | None = "https://cdn.test/out.png"
    error_code: str | None = None
    error_message: str | None = None


@dataclass
class FakeGenerations:
    """按脚本逐次给结局；用光了就一直给最后一条。

    ``submit`` 一律先落 ``pending``，结局在 ``get`` 那一步才出现——真实路径就是
    这样（受理时不碰对方），工具的轮询逻辑因此真的被走到。
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
    """记下写过哪些 key，返回一个可预测的公网地址。"""

    written: dict[str, bytes] = field(default_factory=dict[str, bytes])

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        _ = content_type
        self.written[object_key] = content
        return f"https://cdn.test/{object_key}"


@dataclass
class FakeUnderstanding:
    """给一份固定文档，或抛一个失败。"""

    document: str = "## 4、逐镜拉片表\n**[00:00.000-00:03.800]** 中景……"
    error: Exception | None = None
    calls: list[str] = field(default_factory=list[str])

    async def parse(self, video_url: str) -> str:
        self.calls.append(video_url)
        if self.error is not None:
            raise self.error
        return self.document


__all__ = ["FakeGenerations", "FakeObjects", "FakeUnderstanding", "Outcome"]
