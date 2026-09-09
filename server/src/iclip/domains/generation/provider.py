"""生成 Provider 协议。异步生成返回任务 id 后轮询，同步生成在 submit 中直接返回 output_url。

ProviderError 用于写入任务错误信息；retryable 仅供允许重试的阶段使用，提交阶段不重投。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from iclip.domains.generation.models import GenerationJob

ProviderOutcome = Literal["running", "succeeded", "failed"]


class ProviderError(Exception):
    """Provider 调用错误。retryable 区分暂时故障与请求拒绝，是否重试由当前阶段决定。"""

    def __init__(self, message: str, *, code: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class ImageModelSpec:
    """一家图片模型自报的能力。受理层照它拦请求，能力清单端点照它对外声明，只有这一份。"""

    label: str
    """给人看的模型名。"""

    aspect_ratios: tuple[str, ...]
    resolutions: tuple[str, ...]
    """按全局枚举的顺序声明——端点原样输出，顺序不能随哈希漂。"""

    channels: tuple[str, ...]
    """空元组表示这家没有渠道这个轴；非空时第一个是请求省略 channel 时使用的值。"""


@dataclass(frozen=True, slots=True)
class ProviderSubmission:
    """Provider 提交回执。"""

    provider_task_id: str
    provider_status: str
    raw: dict[str, Any] = field(default_factory=dict[str, Any])
    output_url: str | None = None
    """同步接口一次调用就出结果，直接带回来；异步接口这里是 ``None``。"""


@dataclass(frozen=True, slots=True)
class ProviderProgress:
    """provider 侧一次状态查询的结果。"""

    outcome: ProviderOutcome
    provider_status: str
    raw: dict[str, Any] = field(default_factory=dict[str, Any])
    output_url: str | None = None
    """``outcome == "succeeded"`` 时必有。"""
    watermark_output_url: str | None = None
    """视频成功时上游给的水印版地址；图片 provider 不填。"""
    error_code: str | None = None
    error_message: str | None = None


class GenerationProvider(Protocol):
    """一家生成服务的适配器。"""

    @property
    def name(self) -> str:
        """持久化的 Provider 名称，用于历史对账与排障。"""
        ...

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        """非幂等的付费提交。调用方必须防止同一任务重复提交，恢复约束见 queue.py。"""
        ...

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        """查一次 provider 侧状态。``job.provider_task_id`` 必须已经有值。"""
        ...


__all__ = [
    "GenerationProvider",
    "ImageModelSpec",
    "ProviderError",
    "ProviderOutcome",
    "ProviderProgress",
    "ProviderSubmission",
]
