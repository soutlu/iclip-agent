"""T-GEN-04：生成任务的状态推进、不重投红线，与卡死任务的收拾。

任务体是普通协程，这里直接调（``run_submit`` / ``run_poll`` / ``heal_stalled``）。
**刻意不测 procrastinate 的排期**——「几个同时跑」「谁先被领」「租约多长」是它的契约，
在这儿断言只是把它的实现抄一遍。这里测的是我们自己的判断。

排期只在两处被断言，因为那两处一错就没人发现：**排进了哪条队列**（排错队列 = 没有
worker 消费 = 永远躺着），和**卡死的任务会被捡回来**。
"""

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
    """图像接口提交这一下就出结果，所以不该经过等结果那个状态，也不该排轮询。"""

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
    """先落库再发请求：崩在响应回来之前，那一行必须留在「正在提交」上。"""

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
    """重跑一个卡在「正在提交」上的任务，只许判失败，绝不重投。

    这一条是整套「重跑是安全的」的地基：procrastinate 保证至少一次，我们靠这个守卫
    保证「至少一次」不等于「付两次钱」。两家接口都没有幂等键。
    """

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
    """提交阶段的网络错误也不重试：请求可能已经落到对方那边，我们分不出来。"""

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
    """任务被重跑时那一行可能早有结论了——什么都不该做。"""

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
    """还在跑：抛 ``StillRunning``，由重试策略按**固定间隔**重排，不逐次拉长。

    退避省下的是几次廉价的状态查询，代价是「做完了却没人发现」的延迟越拖越久，而且
    拖得最狠的正是跑得最久的那些任务。用户盯着进度条等的就是这个延迟。
    """

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
    """查状态失败不等于那次生成失败；但对方躺下时要隔久一点再问，别接着捶它。"""

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
    """对方明确拒绝（比如回了个我们不认识的状态），再问一万次也是同样的答案。"""

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
    """对方一直说「在跑」不能就这么问到世界末日：有个总时限。

    固定间隔没有自我收敛的性质，所以这个兜底是必需的，不是可选项。
    """

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
    """收尾一个「提交中断」的行，不能把一次已经成功、已经付过钱的生成盖成失败。

    场景：任务被判卡死重跑了，而就在这个当口，原来那个进程带着真结果回来了。谁有真
    结果谁说话——收尾的写入必须落空。
    """

    job = make_job(image_request(), status=STATUS_SUBMITTING)
    repo = InMemoryGenerationRepository([job])

    # 原来那个进程先把真结果写完（图已生成、已转存、已付过钱）。
    await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/out.png",
        provider_status="succeeded",
        provider_snapshot={},
    )

    # 收尾的那一次随后才动手。
    queue, _ = build_queue(repo)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_COMPLETED
    assert stored.output_url == "https://cdn.test/out.png"
    assert stored.error_code is None


async def test_sync_submit_records_the_reconciliation_id_and_timing() -> None:
    """同步接口没有下一步，所以对账 id 和「发出去的时刻」只有这一步能落库。

    错过就永远不会有人写它们：对不上账、也查不出这次生成花了多久。
    """

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
    """视频那条路 submitted_at 早就填过了，完成时别把它改成「拿到结果的时刻」。"""

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
    """图片提交能占满五分钟，视频提交最多三十秒——它们不能排在同一条队列上。

    也因此排错队列是个哑巴故障：那条队列没有 worker 消费，任务永远躺着，没人报错。
    """

    video = make_job(video_request())
    image = make_job(image_request())
    repo = InMemoryGenerationRepository([video, image])
    queue, connector = build_queue(repo)

    await queue.enqueue_submit(video)
    await queue.enqueue_submit(image)

    routed = {row["queue_name"] for row in connector.jobs.values()}
    assert routed == {QUEUE_SUBMIT_VIDEO, QUEUE_SUBMIT_IMAGE}


async def test_stalled_job_of_a_dead_worker_is_picked_back_up() -> None:
    """procrastinate 自动维护心跳，但**不会**自动重跑死掉的 worker 留下的任务。

    没有这段收拾，一次崩在提交里的生成会永远停在 ``submitting``，一次崩在轮询里的
    生成永远没人再问。重跑之所以安全，见上面那条守卫的测试。
    """

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    queue, connector = build_queue(repo)
    await queue.enqueue_submit(job)

    # 模拟一个 worker 领走了它，然后死了（心跳停在很久以前）。
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
    """心跳还在的 worker 手上那个任务不许动——它可能正做着一次五分钟的图片生成。

    这正是心跳判活比「按最坏耗时估租约」强的地方：判断跟任务多长无关。
    """

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
"""重试策略只看异常类型，不看这个 job——给它一个能构造出来的最简的。"""


def _retry_seconds(queue: GenerationQueue, exception: Exception) -> int:
    """问一下轮询任务的重试策略：碰到这个异常，隔多久再来。"""

    strategy = queue.app.tasks["generation.poll"].retry_strategy
    assert strategy is not None
    decision = strategy.get_retry_decision(exception=exception, job=_ANY_JOB)
    assert decision is not None and decision.retry_at is not None
    return round((decision.retry_at - datetime.now(UTC)).total_seconds())
