"""生成任务调度。procrastinate 管理排期与 worker 心跳，generation_jobs 保存业务事实。

图片提交、视频提交与轮询使用独立队列，避免长时间图片请求阻塞其他任务。
轮询通过 StillRunning 复用重试任务，避免每次查询都新增队列记录；总时限由业务状态控制。

提交前先持久化 submitting。恢复时若仍为 submitting，标记失败且不重投，避免重复计费。
优雅关停的中断任务由重试策略重排；硬中断遗留的 doing 任务由周期任务按心跳恢复。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

import procrastinate
import structlog
from procrastinate import RetryDecision
from procrastinate.jobs import Job as QueuedJob

from iclip.domains.generation.models import (
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationKind,
)
from iclip.domains.generation.provider import GenerationProvider, ProviderError
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import KIND_IMAGE, KIND_VIDEO

_logger = structlog.stdlib.get_logger(__name__)

QUEUE_SUBMIT_IMAGE: Final = "generation-submit-image"
QUEUE_SUBMIT_VIDEO: Final = "generation-submit-video"
QUEUE_POLL: Final = "generation-poll"

_STOP_MARGIN_SECONDS: Final = 5
"""worker 自身关停宽限期之外的等待余量。"""

_SUBMIT_QUEUES: Final[Mapping[GenerationKind, str]] = {
    KIND_IMAGE: QUEUE_SUBMIT_IMAGE,
    KIND_VIDEO: QUEUE_SUBMIT_VIDEO,
}


def queue_dsn(database_url: str) -> str:
    """移除 SQLAlchemy 驱动后缀，将连接串转换为 procrastinate 使用的 psycopg 格式。"""

    scheme, _, rest = database_url.partition("://")
    return f"{scheme.split('+')[0]}://{rest}"


class StillRunning(Exception):
    """Provider 仍在运行的调度信号，借重试策略安排下一次轮询，不代表生成失败。"""


@dataclass(frozen=True, slots=True)
class GenerationQueueSettings:
    """生成队列的轮询、并发与 worker 生命周期配置。"""

    poll_interval_seconds: int = 5
    """固定轮询间隔，避免退避增加长任务完成后的发现延迟。"""

    error_retry_seconds: int = 30
    """故障后的重试间隔，长于正常轮询间隔以降低故障期间的请求压力。"""

    job_timeout_seconds: int = 3600
    """提交后达到此时限仍无终态则失败，限制持续轮询的总时长。"""

    submit_concurrency: int = 100
    poll_concurrency: int = 100

    shutdown_grace_seconds: int = 15
    """关停时等待执行中任务的时限；超时中断的提交由恢复流程判定结果。"""

    stalled_worker_timeout_seconds: int = 30
    """按心跳失联时间判定 worker 中断，与任务自身耗时无关。"""

    heartbeat_interval_seconds: int = 10


class _Retry(procrastinate.RetryStrategy):
    """StillRunning 使用正常轮询间隔，其他异常使用错误间隔。

    不设置尝试次数上限：任务通过总时限或 submitting 状态收尾，避免队列停止重试后
    业务记录仍停留在非终态。继承 RetryStrategy 以匹配 procrastinate 的参数类型。"""

    def __init__(self, settings: GenerationQueueSettings) -> None:
        super().__init__()
        self._settings = settings

    def get_retry_decision(
        self, *, exception: BaseException, job: QueuedJob
    ) -> RetryDecision | None:
        seconds = (
            self._settings.poll_interval_seconds
            if isinstance(exception, StillRunning)
            else self._settings.error_retry_seconds
        )
        return RetryDecision(retry_in={"seconds": seconds})


class GenerationQueue:
    """推进持久化生成任务，任务协程可独立于调度器调用。"""

    def __init__(
        self,
        repo: GenerationRepository,
        *,
        providers: Mapping[GenerationKind, GenerationProvider],
        connector: procrastinate.BaseConnector,
        settings: GenerationQueueSettings | None = None,
    ) -> None:
        self._repo = repo
        self._providers = providers
        self._settings = settings or GenerationQueueSettings()
        self._app = procrastinate.App(connector=connector)
        self._workers: tuple[asyncio.Task[None], ...] = ()

        retry = _Retry(self._settings)
        self._submit = self._app.task(
            name="generation.submit",
            # defer 时按生成类型覆盖队列。
            queue=QUEUE_SUBMIT_VIDEO,
            retry=retry,
        )(self.run_submit)
        self._poll = self._app.task(
            name="generation.poll",
            queue=QUEUE_POLL,
            retry=retry,
        )(self.run_poll)
        heal = self._app.task(
            name="generation.heal_stalled",
            # 周期任务必须使用已有 worker 消费的队列。
            queue=QUEUE_POLL,
            pass_context=True,
        )(self._heal_periodic)
        self._app.periodic(cron="* * * * *", periodic_id="generation-heal")(heal)

    @property
    def app(self) -> procrastinate.App:
        """供组合根管理队列连接生命周期。"""

        return self._app

    async def enqueue_submit(self, job: GenerationJob) -> None:
        """将任务加入对应提交队列；入库与排队分属不同事务，排队失败由服务层标记失败。"""

        await self._submit.configure(
            queue=_SUBMIT_QUEUES[job.kind],
            task_kwargs={"job_id": str(job.id)},
        ).defer_async()

    async def run_submit(self, job_id: str) -> None:
        """提交一次生成；恢复时不得重复调用付费生成接口。"""

        job = await self._repo.get(uuid.UUID(job_id), owner=None)
        if job.status == STATUS_SUBMITTING:
            # 提交结果未知，恢复时标记失败，避免重复计费。
            await self._fail_stranded(job)
            return
        if job.status != STATUS_PENDING:
            _logger.info("生成任务已有结论，不再提交", job_id=job.id, status=job.status)
            return

        # 提交前持久化状态，确保请求中断后不会被视为未提交而重投。
        await self._repo.mark_submitting(job.id)
        try:
            submission = await self._providers[job.kind].submit(job)
        except ProviderError as exc:
            # 提交阶段忽略 retryable 标记，防止请求已受理时重复计费。
            await self._repo.mark_failed(job.id, error_code=exc.code, error_message=str(exc))
            _logger.warning("生成任务提交失败", job_id=job.id, code=exc.code, error=str(exc))
            return

        if submission.output_url is not None:
            # 同步接口没有轮询阶段，完成时同时保存回执任务 id。
            await self._repo.mark_completed(
                job.id,
                output_url=submission.output_url,
                provider_status=submission.provider_status,
                provider_snapshot=submission.raw,
                provider_task_id=submission.provider_task_id,
            )
            return

        await self._repo.mark_submitted(
            job.id,
            provider_task_id=submission.provider_task_id,
            provider_status=submission.provider_status,
            provider_snapshot=submission.raw,
        )
        await self._poll.configure(
            task_kwargs={"job_id": str(job.id)},
            schedule_in={"seconds": self._settings.poll_interval_seconds},
        ).defer_async()

    async def run_poll(self, job_id: str) -> None:
        """查一次 provider 侧状态。还没结果就抛 ``StillRunning``，由重试策略重排。"""

        job = await self._repo.get(uuid.UUID(job_id), owner=None)
        if job.status != STATUS_SUBMITTED:
            _logger.info("生成任务已有结论，不再轮询", job_id=job.id, status=job.status)
            return
        if self._timed_out(job):
            await self._repo.mark_failed(
                job.id,
                error_code="PROVIDER_TIMEOUT",
                error_message=(
                    f"提交后 {self._settings.job_timeout_seconds} 秒仍无终态，按超时收尾"
                ),
            )
            return

        try:
            progress = await self._providers[job.kind].poll(job)
        except ProviderError as exc:
            if exc.retryable:
                raise
            await self._repo.mark_failed(job.id, error_code=exc.code, error_message=str(exc))
            return

        if progress.outcome == "succeeded" and progress.output_url is not None:
            await self._repo.mark_completed(
                job.id,
                output_url=progress.output_url,
                provider_status=progress.provider_status,
                provider_snapshot=progress.raw,
            )
            return
        if progress.outcome == "failed":
            await self._repo.mark_failed(
                job.id,
                error_code=progress.error_code or "PROVIDER_FAILED",
                error_message=progress.error_message or "provider 报告生成失败",
                provider_status=progress.provider_status,
                provider_snapshot=progress.raw,
            )
            return

        await self._repo.record_progress(
            job.id,
            provider_status=progress.provider_status,
            provider_snapshot=progress.raw,
        )
        raise StillRunning(f"{job.id} 还在跑（{progress.provider_status}）")

    async def heal_stalled(self, *, skip_job_id: int | None = None) -> int:
        """重排失联 worker 遗留的 doing 任务，返回数量。

        procrastinate 只提供失联查询，必须显式重排；恢复提交由 run_submit 的状态检查防止重投。
        优雅关停引发的任务异常由 _Retry 处理。"""

        stalled = await self._app.job_manager.get_stalled_jobs(
            seconds_since_heartbeat=self._settings.stalled_worker_timeout_seconds
        )
        healed = 0
        now = datetime.now(UTC)
        for queued in stalled:
            if queued.id is None or queued.id == skip_job_id:
                continue
            await self._app.job_manager.retry_job_by_id_async(job_id=queued.id, retry_at=now)
            healed += 1
        if healed:
            _logger.warning("捡回中断的生成任务（原 worker 已失联）", count=healed)
        return healed

    async def _heal_periodic(self, context: procrastinate.JobContext, timestamp: int) -> None:
        """周期恢复任务，排除自身以免 worker 记录丢失时将自身误判为停滞任务。"""

        await self.heal_stalled(skip_job_id=context.job.id)

    def start(self) -> None:
        """幂等启动三个队列 worker。"""

        if self._workers:
            return
        settings = self._settings
        lanes = (
            (QUEUE_SUBMIT_IMAGE, settings.submit_concurrency),
            (QUEUE_SUBMIT_VIDEO, settings.submit_concurrency),
            (QUEUE_POLL, settings.poll_concurrency),
        )
        self._workers = tuple(
            asyncio.create_task(
                self._app.run_worker_async(
                    queues=[queue],
                    name=queue,
                    concurrency=concurrency,
                    shutdown_graceful_timeout=settings.shutdown_grace_seconds,
                    update_heartbeat_interval=settings.heartbeat_interval_seconds,
                    stalled_worker_timeout=settings.stalled_worker_timeout_seconds,
                    # 信号处理统一交给 uvicorn，避免覆盖 SIGTERM 处理器。
                    install_signal_handlers=False,
                    delete_jobs="successful",
                ),
                name=f"generation-worker-{queue}",
            )
            for queue, concurrency in lanes
        )

    async def stop(self) -> None:
        """取消 worker 并在宽限期内等待退出，避免阻塞进程关停。

        未完成的提交保留 submitting，由恢复流程收尾。"""

        if not self._workers:
            return
        workers, self._workers = self._workers, ()
        for worker in workers:
            worker.cancel()
        _, pending = await asyncio.wait(
            workers, timeout=self._settings.shutdown_grace_seconds + _STOP_MARGIN_SECONDS
        )
        for worker in pending:
            _logger.warning(
                "生成 worker 没在关停宽限期内收干净，不再等它", worker=worker.get_name()
            )

    async def _fail_stranded(self, job: GenerationJob) -> None:
        """将中断的 submitting 任务标记失败；条件更新避免覆盖原 worker 并发写入的结果。"""

        failed = await self._repo.mark_failed(
            job.id,
            error_code="SUBMIT_INTERRUPTED",
            error_message=(
                "提交中途进程中断，无法确认 provider 是否已收下这次生成；"
                "为免重复计费不自动重投，请确认后重新发起"
            ),
            only_if_status=STATUS_SUBMITTING,
        )
        if failed is None:
            _logger.info("生成任务在收尾之前已有结论，不改它", job_id=job.id)
            return
        _logger.warning("生成任务提交中断，已判失败", job_id=job.id)

    def _timed_out(self, job: GenerationJob) -> bool:
        started = job.submitted_at or job.created_at
        elapsed = (datetime.now(UTC) - started).total_seconds()
        return elapsed > self._settings.job_timeout_seconds


__all__ = [
    "QUEUE_POLL",
    "QUEUE_SUBMIT_IMAGE",
    "QUEUE_SUBMIT_VIDEO",
    "GenerationQueue",
    "GenerationQueueSettings",
    "StillRunning",
    "queue_dsn",
]
