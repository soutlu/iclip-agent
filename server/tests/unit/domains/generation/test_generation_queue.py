"""直接调用任务协程，验证生成状态推进、提交幂等边界、队列选择和失联任务恢复。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from procrastinate.jobs import Job as QueuedJob
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
)
from iclip.domains.generation.provider import (
    GenerationProvider,
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.queue import (
    QUEUE_POLL,
    QUEUE_SUBMIT_IMAGE,
    QUEUE_SUBMIT_VIDEO,
    GenerationQueue,
    GenerationQueueSettings,
    StillRunning,
)
from tests.helpers.generation import (
    InMemoryGenerationRepository,
    ScriptedProvider,
    image_request,
    make_job,
    video_request,
)

SETTINGS = GenerationQueueSettings(
    poll_interval_seconds=5, error_retry_seconds=30, job_timeout_seconds=3600
)


def build_queue(
    repo: InMemoryGenerationRepository,
    *,
    video: ScriptedProvider | None = None,
    image: ScriptedProvider | None = None,
) -> tuple[GenerationQueue, InMemoryConnector]:
    providers: dict[str, GenerationProvider] = {
        "video": video or ScriptedProvider(),
        "image": image or ScriptedProvider(),
    }
    connector = InMemoryConnector()
    queue = GenerationQueue(
        repo,
        providers=providers,  # type: ignore[arg-type]
        connector=connector,
        settings=SETTINGS,
    )
    return queue, connector


async def test_async_submit_moves_job_to_waiting_for_result() -> None:
    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="queued")
    )

    queue, connector = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_SUBMITTED
    assert stored.provider_task_id == "t-1"
    assert stored.submitted_at is not None

    polls = [row for row in connector.jobs.values() if row["task_name"] == "generation.poll"]
    assert len(polls) == 1, "提交完必须排一次轮询，否则永远没人问结果"
    assert polls[0]["queue_name"] == QUEUE_POLL


async def test_sync_submit_completes_in_one_step() -> None:

    job = make_job(image_request())
    repo = InMemoryGenerationRepository([job])
    image = ScriptedProvider(
        submission=ProviderSubmission(
            provider_task_id=str(job.id),
            provider_status="succeeded",
            output_url="https://cdn.test/out.png",
        )
    )

    queue, connector = build_queue(repo, image=image)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_COMPLETED
    assert stored.output_url == "https://cdn.test/out.png"
    assert image.poll_calls == [], "同步接口不该被轮询"
    assert connector.jobs == {}, "已经终态了，别再排一次轮询"


async def test_marks_submitting_before_calling_provider() -> None:
    """请求前持久化 submitting，保证进程在响应前中断时留下提交状态。"""

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    seen: list[str] = []

    class Recording(ScriptedProvider):
        async def submit(self, job_arg):  # type: ignore[no-untyped-def]
            seen.append(repo.jobs[job_arg.id].status)
            return await super().submit(job_arg)

    video = Recording(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="queued")
    )
    queue, _ = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))
    assert seen == [STATUS_SUBMITTING]


async def test_stranded_submitting_job_fails_and_is_never_resubmitted() -> None:
    """队列至少执行一次，供应商却无幂等键；重跑 submitting 任务只能失败，不能重复计费。"""

    job = make_job(video_request(), status=STATUS_SUBMITTING)
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-2", provider_status="queued")
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "SUBMIT_INTERRUPTED"
    assert video.submit_calls == [], "绝不能重新提交一次"


async def test_submit_failure_is_terminal_even_when_retryable() -> None:
    """网络失败无法判定供应商是否收到提交，因此提交不可重试。"""

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderError("超时了", code="PROVIDER_UNREACHABLE", retryable=True)
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_UNREACHABLE"


async def test_already_terminal_job_is_not_submitted_again() -> None:

    job = make_job(video_request(), status=STATUS_COMPLETED)
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="queued")
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))

    assert video.submit_calls == []
    assert repo.jobs[job.id].status == STATUS_COMPLETED


async def test_poll_success_and_failure_reach_terminal_states() -> None:
    succeeded = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([succeeded])
    video = ScriptedProvider(
        progress=ProviderProgress(
            outcome="succeeded",
            provider_status="succeeded",
            output_url="https://cdn.test/v.mp4",
        )
    )
    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(succeeded.id))
    assert repo.jobs[succeeded.id].status == STATUS_COMPLETED

    failed = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-2")
    repo = InMemoryGenerationRepository([failed])
    video = ScriptedProvider(
        progress=ProviderProgress(
            outcome="failed",
            provider_status="failed",
            error_code="NSFW",
            error_message="被拦了",
        )
    )
    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(failed.id))
    assert repo.jobs[failed.id].error_code == "NSFW"


async def test_running_job_asks_again_at_a_fixed_interval() -> None:
    """固定间隔查询运行中任务，避免退避放大完成通知延迟。"""

    job = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderProgress(outcome="running", provider_status="running")
    )
    queue, _ = build_queue(repo, video=video)

    with pytest.raises(StillRunning):
        await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_SUBMITTED, "还在跑不是失败"
    assert stored.provider_status == "running", "问到的东西要记下来"

    decision = _retry_seconds(queue, StillRunning("还在跑"))
    assert decision == SETTINGS.poll_interval_seconds


async def test_unreachable_provider_waits_longer_than_normal() -> None:
    """状态查询故障不等于生成失败，使用更长间隔重试查询。"""

    job = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderError("网络抖了", code="PROVIDER_UNREACHABLE", retryable=True)
    )

    queue, _ = build_queue(repo, video=video)
    with pytest.raises(ProviderError):
        await queue.run_poll(str(job.id))

    assert repo.jobs[job.id].status == STATUS_SUBMITTED, "问不通不改那次生成的结论"
    waited = _retry_seconds(queue, ProviderError("x", code="Y", retryable=True))
    assert waited > SETTINGS.poll_interval_seconds
    assert waited == SETTINGS.error_retry_seconds


async def test_non_retryable_poll_error_is_terminal() -> None:

    job = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderError("没见过的状态", code="PROVIDER_BAD_STATUS", retryable=False)
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_BAD_STATUS"


async def test_job_stuck_running_forever_eventually_times_out() -> None:
    """固定间隔轮询必须受总时限约束，避免供应商持续 running 导致无限轮询。"""

    stale = datetime.now(UTC) - timedelta(seconds=SETTINGS.job_timeout_seconds + 60)
    job = make_job(
        video_request(),
        status=STATUS_SUBMITTED,
        provider_task_id="t-1",
        submitted_at=stale,
    )
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderProgress(outcome="running", provider_status="running")
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_TIMEOUT"
    assert video.poll_calls == [], "超时先判掉，不再多问一次"


async def test_stranded_cleanup_never_overwrites_a_real_result() -> None:
    """失联恢复可能与原 worker 返回结果并发；清理更新不得覆盖已成功结果。"""

    job = make_job(image_request(), status=STATUS_SUBMITTING)
    repo = InMemoryGenerationRepository([job])

    await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/out.png",
        provider_status="succeeded",
        provider_snapshot={},
    )

    queue, _ = build_queue(repo)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_COMPLETED
    assert stored.output_url == "https://cdn.test/out.png"
    assert stored.error_code is None


async def test_sync_submit_records_the_reconciliation_id_and_timing() -> None:
    """同步接口仅一次状态跳转，对账 id 与提交时间须在此阶段记录。"""

    job = make_job(image_request())
    repo = InMemoryGenerationRepository([job])
    image = ScriptedProvider(
        submission=ProviderSubmission(
            provider_task_id=str(job.id),
            provider_status="succeeded",
            output_url="https://cdn.test/out.png",
        )
    )

    queue, _ = build_queue(repo, image=image)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_COMPLETED
    assert stored.provider_task_id == str(job.id)
    assert stored.submitted_at is not None
    assert stored.finished_at is not None


async def test_async_submit_keeps_the_original_submitted_at() -> None:

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="queued")
    )
    queue, _ = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))
    submitted_at = repo.jobs[job.id].submitted_at
    assert submitted_at is not None

    video_done = ScriptedProvider(
        progress=ProviderProgress(
            outcome="succeeded",
            provider_status="succeeded",
            output_url="https://cdn.test/v.mp4",
        )
    )
    queue, _ = build_queue(repo, video=video_done)
    await queue.run_poll(str(job.id))

    assert repo.jobs[job.id].submitted_at == submitted_at


async def test_each_kind_goes_to_its_own_queue() -> None:
    """图像与视频提交耗时不同，须进入各自有 worker 消费的队列。"""

    video = make_job(video_request())
    image = make_job(image_request())
    repo = InMemoryGenerationRepository([video, image])
    queue, connector = build_queue(repo)

    await queue.enqueue_submit(video)
    await queue.enqueue_submit(image)

    routed = {row["queue_name"] for row in connector.jobs.values()}
    assert routed == {QUEUE_SUBMIT_VIDEO, QUEUE_SUBMIT_IMAGE}


async def test_stalled_job_of_a_dead_worker_is_picked_back_up() -> None:
    """procrastinate 维护心跳但不自动恢复失联 worker 的任务，需显式重排。"""

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    queue, connector = build_queue(repo)
    await queue.enqueue_submit(job)

    # 模拟任务已认领且 worker 心跳过期。
    worker_id = await queue.app.job_manager.register_worker()
    queued = await queue.app.job_manager.fetch_job(queues=[QUEUE_SUBMIT_VIDEO], worker_id=worker_id)
    assert queued is not None and queued.id is not None
    assert connector.jobs[queued.id]["status"] == "doing"
    connector.workers[worker_id] = datetime.now(UTC) - timedelta(
        seconds=SETTINGS.stalled_worker_timeout_seconds + 60
    )

    assert await queue.heal_stalled() == 1
    assert connector.jobs[queued.id]["status"] == "todo", "捡回去重排，等着守卫来收尾"


async def test_healer_leaves_a_live_workers_job_alone() -> None:
    """存活由 worker 心跳决定，不能因长耗时生成而重排其任务。"""

    job = make_job(image_request())
    repo = InMemoryGenerationRepository([job])
    queue, connector = build_queue(repo)
    await queue.enqueue_submit(job)

    worker_id = await queue.app.job_manager.register_worker()
    queued = await queue.app.job_manager.fetch_job(queues=[QUEUE_SUBMIT_IMAGE], worker_id=worker_id)
    assert queued is not None and queued.id is not None

    assert await queue.heal_stalled() == 0
    assert connector.jobs[queued.id]["status"] == "doing"


_ANY_JOB = QueuedJob(
    id=1, queue=QUEUE_POLL, lock=None, queueing_lock=None, task_name="generation.poll"
)
"""重试策略只依赖异常类型，使用最小有效 job。"""


def _retry_seconds(queue: GenerationQueue, exception: Exception) -> int:
    """读取指定异常对应的轮询重试间隔。"""

    strategy = queue.app.tasks["generation.poll"].retry_strategy
    assert strategy is not None
    decision = strategy.get_retry_decision(exception=exception, job=_ANY_JOB)
    assert decision is not None and decision.retry_at is not None
    return round((decision.retry_at - datetime.now(UTC)).total_seconds())
