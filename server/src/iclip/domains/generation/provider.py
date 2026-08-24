"""生成 provider 的端口：提交一次生成，然后问它做完了没有。

视频和图片走同一个协议，尽管两家的接口形状差得很远：视频是「提交拿 task id，之后
轮询」，图片那家是同步的——一次调用就等到结果。同步那种在 ``submit`` 里直接带回
``output_url``，于是「提交完就已经是终态」和「提交完还要等」在上层是同一段代码的两
个分支，而不是两条平行的流程。

provider 的失败一律用 ``ProviderError``（``retryable`` 区分「等会儿再试」和「这次
生成没救了」）。不用领域错误分类学：这条路径上没有等在线上的 HTTP 请求，失败的去
处是 job 行里的 error_code，不是状态码。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from iclip.domains.generation.models import GenerationJob

ProviderOutcome = Literal["running", "succeeded", "failed"]


class ProviderError(Exception):
    """provider 调用失败。

    ``retryable=True`` 表示这次失败与本次生成的内容无关（网络、限流、5xx），过一会
    儿重试有意义；``False`` 表示 provider 明确拒绝了这次请求（参数不合它的规矩、
    内容审核不通过），重试只会得到同样的答案。
    """

    def __init__(self, message: str, *, code: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class ProviderSubmission:
    """provider 收下一次生成之后给的回执。"""

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
    error_code: str | None = None
    error_message: str | None = None


class GenerationProvider(Protocol):
    """一家生成服务的适配器。"""

    @property
    def name(self) -> str:
        """provider 名，落在 job 行上（对账与排障时要知道是谁生成的）。"""
        ...

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        """把一次生成提交给 provider。

        **这个调用不是幂等的**：两家接口都没有幂等键，重复调用就是重复计费。调用
        方必须保证同一个 job 只走到这里一次（见 ``queue.py`` 对 ``submitting``
        状态的处置）。
        """
        ...

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        """查一次 provider 侧状态。``job.provider_task_id`` 必须已经有值。"""
        ...


__all__ = [
    "GenerationProvider",
    "ProviderError",
    "ProviderOutcome",
    "ProviderProgress",
    "ProviderSubmission",
]
