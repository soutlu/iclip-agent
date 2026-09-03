"""生成任务的排期：三条队列 + 一个收拾卡死任务的周期任务。

排队机械交给 procrastinate（Postgres 原生的任务队列），**业务判断一条不交**。分工是
这样的：

```text
它管：谁该跑、什么时候跑、几个同时跑、进程死了谁发现
我管：提交出去算不算数、不知道发没发出去时怎么办、什么时候算彻底超时
```

**表还是我们自己的。** ``iclip.generation_jobs`` 是一次生成的事实；procrastinate 的
表只是「这件事还没做完」的排期机械，随时可以清空重排而不损失任何事实。

```text
POST /generations ──▶ 插一行 pending ──▶ defer 提交任务
                                           │
        ┌──────────────────────────────────┴──────┐
        ▼                                          ▼
   submit-image 队列                          submit-video 队列
        └──────────────┬───────────────────────────┘
                       ▼
              pending ──▶ submitting ──provider──▶ 有 output_url？
                             │                      ├─ 有 → completed（同步接口）
                             │ 崩在这里              └─ 没有 → submitted，defer 轮询
                             ▼
                      被重跑时守卫看见 submitting ──▶ failed（不重投：可能已计费）

                    poll 队列：查一次 ──┬─ 还在跑 → 抛 StillRunning，5 秒后重试
                                       ├─ 成了   → completed
                                       ├─ 废了   → failed
                                       └─ 问不通 → 30 秒后重试
```

**「还在跑」借重试通道走，但它不是失败。** 每 5 秒 defer 一个新任务的话，一个生成
一小时就往它的表里写七百多行；改成让任务抛异常、由我们自己的重试策略决定「5 秒后再
来」，一个生成始终只占一行，``attempts`` 正好就是问过几次。重试策略是我们写的，所
以「还在跑」的语义没有被改成「出错了」。

**三条队列切开，是因为耗时差着数量级**（图片提交 300 秒 / 视频提交 30 秒 / 查状态 1
秒）。混在一条里，一批图片会把视频按在后面等。并发按「纯等待」开到一百：这两件事几
乎整段时间都挂在对方的 socket 上，CPU 是空的。数据库连接也不必加——连接只在状态跳
转那几毫秒里开合，从不跨着那次 HTTP 调用握着。

**进程死掉之后，任务怎么回来，分两种。** 这一段容易看漏：

- **优雅关停**（部署、重启）：宽限期到了会打断还在飞的任务，而被打断的任务是抛异常
  结束的，重试策略把它重排回待办。这一半不用我们管。
- **硬杀**（SIGKILL、OOM、机器没了）：任务留在「有人在做」上，那个 worker 的心跳
  停了。procrastinate 自动维护心跳，但**不会**自动重跑——``get_stalled_jobs`` 是个
  查询，``retry_job`` 是一次手动调用。所以下面那个周期任务是必需的，不是锦上添花：
  没有它，一次崩在提交里的生成永远停在 ``submitting``，而它可能已经付过钱了。

**重跑是安全的，靠的是任务体第一句话的守卫**（重读那一行，看见 ``submitting`` 就照
实判失败），不是靠「不会重跑」。两家接口都没有幂等键，重投一次就是重复付一次钱。
"""

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
"""收 worker 时在它自己的宽限期之外多等这么久。"""

_SUBMIT_QUEUES: Final[Mapping[GenerationKind, str]] = {
    KIND_IMAGE: QUEUE_SUBMIT_IMAGE,
    KIND_VIDEO: QUEUE_SUBMIT_VIDEO,
}


def queue_dsn(database_url: str) -> str:
    """把 SQLAlchemy 的连接串改成 psycopg 认的那种。

    procrastinate 只支持 psycopg，而本仓其余部分走 asyncpg——同一个库，两个驱动。
    ``postgresql+asyncpg://...`` 这种带方言后缀的写法只有 SQLAlchemy 认，psycopg 会
    把 ``+asyncpg`` 当成主机名的一部分。
    """

    scheme, _, rest = database_url.partition("://")
    return f"{scheme.split('+')[0]}://{rest}"


class StillRunning(Exception):
    """provider 说还在跑。

    借异常走，是因为「下次什么时候再问」在 procrastinate 里是重试策略的事。它不表示
    出错——见本模块开头。
    """


@dataclass(frozen=True, slots=True)
class GenerationQueueSettings:
    """排期的几个节奏。默认值按「视频几分钟、图片几分钟」的量级选的。"""

    poll_interval_seconds: int = 5
    """还在跑就隔这么久再问一次。**固定间隔，不做逐次拉长的退避**——退避省下的是几
    次廉价的状态查询，代价是「做完了却没人发现」的延迟越拖越久，而且拖得最狠的正是
    跑得最久的那些任务。用户盯着进度条等的就是这个延迟。"""

    error_retry_seconds: int = 30
    """出错或被中断之后隔这么久再来。

    比正常间隔长，是为了别在对方已经躺下的时候按正常节奏接着捶它：几百个在飞的任务
    每 5 秒重试一次，只会让它更起不来。"""

    job_timeout_seconds: int = 3600
    """从提交算起，超过这么久还没终态就判失败。

    固定间隔没有自我收敛的性质：一个永远说「在跑」的任务会被问到这个时限为止。所以
    这是必需的兜底，不是可选项。"""

    submit_concurrency: int = 100
    poll_concurrency: int = 100
    """一条队列同时在飞多少个。按「纯等待」定的——见本模块开头。"""

    shutdown_grace_seconds: int = 15
    """关停时给在飞的任务多少时间收尾，超了就打断。

    不能无限等：一次图像提交最长十几分钟，等它等于把整个进程的关停拖那么久，而部署
    环境的关停超时一到照样会杀进程——那时被打断的东西一样多，只是没人知道。被打断
    的行停在 ``submitting`` 上，由那个周期任务照实收尾。"""

    stalled_worker_timeout_seconds: int = 30
    """心跳断了这么久就认为那个 worker 没了，它手上的任务可以重跑。

    **这个判断跟任务本身多长完全无关**，所以不需要「按最坏耗时估租约」那一套：一个
    正在做 300 秒图片提交的活 worker 每 10 秒报一次心跳，永远不会被误判。"""

    heartbeat_interval_seconds: int = 10


class _Retry(procrastinate.RetryStrategy):
    """两个任务共用的重排策略：还在跑就按正常间隔，别的都按更长的错误间隔。

    继承的是具体的 ``RetryStrategy`` 而不是文档说的 ``BaseRetryStrategy``：``retry=``
    参数的类型只写了前者，虽然两者都能跑。挑能过类型检查的那个。

    **没有次数上限是刻意的，而且是必需的。** 界不在这里，在任务体的第一句话：

    - 轮询：撞上总时限就写成终态、正常返回，不再抛异常。
    - 提交：重读那一行，看见 ``submitting`` 就照实判失败、正常返回。

    所以每个任务最多多跑一次就自己停了——上限是**守卫**给的，不是计数器给的。反过来
    要是在这里设了上限，次数用完的任务会落在终态上，而它对应的那一行还停在
    ``submitting``：一次可能已经付过钱的生成，永远没有结论，也没人知道。
    """

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
    """把 ``generation_jobs`` 里的行往前推。

    任务体（``run_submit`` / ``run_poll`` / ``heal_stalled``）都是普通协程，可以直接
    调——测试测的是这几段判断，不是 procrastinate 的排期。
    """

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
            # 队列在 defer 的时候按生成类型覆盖；这里给的只是个不会被用到的默认值。
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
            # 挂在轮询队列上：周期任务 defer 到没人消费的队列会永远躺在那儿。
            queue=QUEUE_POLL,
            pass_context=True,
        )(self._heal_periodic)
        self._app.periodic(cron="* * * * *", periodic_id="generation-heal")(heal)

    @property
    def app(self) -> procrastinate.App:
        """给组合根开/关连接，以及测试查队列里有什么。"""

        return self._app

    async def enqueue_submit(self, job: GenerationJob) -> None:
        """把一次刚受理的生成排进提交队列。

        调用方（``GenerationService``）负责在这一步失败时把那行判失败：插行走
        asyncpg、排队走 psycopg，两个驱动两个事务，做不到原子。
        """

        await self._submit.configure(
            queue=_SUBMIT_QUEUES[job.kind],
            task_kwargs={"job_id": str(job.id)},
        ).defer_async()

    async def run_submit(self, job_id: str) -> None:
        """提交一次生成。**同一个 job 只允许真的提交一次。**"""

        job = await self._repo.get(uuid.UUID(job_id), owner=None)
        if job.status == STATUS_SUBMITTING:
            # 上一次崩在提交里了。守卫：不知道发出去没有，照实判失败，绝不重投。
            await self._fail_stranded(job)
            return
        if job.status != STATUS_PENDING:
            # 已经有结论了（重跑、或者重复排进来一次）。什么都不做。
            _logger.info("生成任务已有结论，不再提交", job_id=job.id, status=job.status)
            return

        # 先落库再发请求。反过来的话，崩在响应回来之前这行还是 pending，重跑时会
        # 再提交一次——而上一次可能已经计过费了。
        await self._repo.mark_submitting(job.id)
        try:
            submission = await self._providers[job.kind].submit(job)
        except ProviderError as exc:
            # 提交阶段一律不重试，连「可重试」的网络错误也不：请求可能已经落到对方
            # 那边了，我们分不出来。
            await self._repo.mark_failed(job.id, error_code=exc.code, error_message=str(exc))
            _logger.warning("生成任务提交失败", job_id=job.id, code=exc.code, error=str(exc))
            return

        if submission.output_url is not None:
            # 同步接口：提交这一下就已经出结果了。回执里的 task id 也得在这里落库——
            # 它没有下一步了，错过就永远不会有人写它。
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
                # 查状态失败不影响那次生成本身，隔久一点再问。
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
        """把失联的 worker 手上那些任务重新排回去。返回捡起来几个。

        **这一段是必需的**，不是保险：procrastinate 自动维护心跳，但重跑要自己调
        （``get_stalled_jobs`` 只是个查询）。没有它，一次硬杀（SIGKILL、OOM、机器没
        了）会让任务永远躺在 ``doing`` 上——对应那一行就永远停在 ``submitting``，而
        它可能已经付过钱了。重跑之所以安全，靠的是 ``run_submit`` 第一句话的守卫。

        **只管硬杀这一种。** 优雅关停打断在飞任务那一种不用管：那时任务是抛异常结束
        的，``_Retry`` 会把它重排回 ``todo``，下次起来自然会跑（实测过）。这也是那个
        策略不能设次数上限的原因之一——用完次数的任务会落在终态上，就再没人捡了。
        """

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
        """周期任务的外壳。``timestamp`` 是 procrastinate 传的这一拍的时刻，用不上。

        跳过自己：这个任务自己正处在「在跑」状态，而它的 worker 行万一被清掉过，它
        就会把自己也当成卡死的捡一次。
        """

        await self.heal_stalled(skip_job_id=context.job.id)

    def start(self) -> None:
        """起三个 worker。重复调用无副作用。"""

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
                    # 信号归 uvicorn 管。默认是 True，那会让 procrastinate 抢
                    # SIGTERM——两边都装处理器，关停顺序就成了谁先注册谁说了算。
                    install_signal_handlers=False,
                    # 成功的任务跑完就删。失败的留着，那是要人看的。
                    delete_jobs="successful",
                ),
                name=f"generation-worker-{queue}",
            )
            for queue, concurrency in lanes
        )

    async def stop(self) -> None:
        """收掉 worker。

        ``run_worker_async`` 被 cancel 之后自己会走优雅关停：先停领新活，再等在飞的
        任务到 ``shutdown_grace_seconds``，还没完的打断。被打断的提交停在
        ``submitting`` 上，下次由 ``heal_stalled`` 照实收尾。

        **等待带上限，不等到底。** 这一段跑在整个进程的关停路径上，无论 worker 因为
        什么原因收不干净，都不能把进程卡在这儿——那会让部署超时，然后被硬杀，结果比
        主动放手更糟。宽限期本来就是 worker 自己那一层的上限，这里再多留一点余量。
        """

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
        """处置卡在 ``submitting`` 上的行：判失败，说清为什么不重投。

        写入带状态守卫。判断和写入之间隔着一次 await，那当口原来那个进程可能刚把真
        结果写完——守卫保证「谁有真结果谁说话」。
        """

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
