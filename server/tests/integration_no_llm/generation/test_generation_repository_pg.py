"""验证生成仓储的数据库时钟、JSON 往返、外键、组合约束、条件更新原子性与分叉继承的读范围。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.common.errors import NotFound
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.models import Conversation
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
)
from iclip.domains.generation.schemas import GenerationRequest
from tests.helpers.generation import (
    compose_request,
    edit_request,
    image_request,
    make_composite,
    make_edit,
    make_job,
    video_request,
)
from tests.helpers.pg import reset_database


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    created = create_async_engine(migrated_pg)
    async with created.begin() as conn:
        await reset_database(conn)
    try:
        yield created
    finally:
        await created.dispose()


async def make_user(engine: AsyncEngine) -> uuid.UUID:
    """先创建用户以满足 generation_jobs 的属主外键。"""

    user_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.users"
                " (id, email, hashed_password, is_active, is_superuser, is_verified,"
                "  display_name, avatar_url, roles, direct_permissions, city, job_title,"
                "  departments)"
                " VALUES (:id, :email, 'x', true, false, true, '', '',"
                " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
            ),
            {"id": user_id, "email": f"{user_id}@example.test"},
        )
    return user_id


async def insert_job(
    repo: SqlGenerationRepository,
    owner: uuid.UUID,
    request: GenerationRequest | None = None,
) -> GenerationJob:
    return await repo.create(make_job(request or video_request(), owner_user_id=owner))


async def test_timestamps_come_from_the_database_clock(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    stale = datetime.now(UTC) - timedelta(days=365)

    job = await repo.create(make_job(video_request(), owner_user_id=owner, created_at=stale))

    assert job.status == STATUS_PENDING
    assert job.created_at.tzinfo is not None
    assert job.created_at > stale + timedelta(days=1), "应用传进来的时刻被数据库改写了"
    assert job.submitted_at is None and job.finished_at is None


async def test_state_transitions_round_trip_through_the_table(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    request = video_request(reference_image_urls=["https://example.test/first.png"])
    job = await insert_job(repo, owner, request)

    assert (await repo.mark_submitting(job.id)).status == STATUS_SUBMITTING
    submitted = await repo.mark_submitted(
        job.id,
        provider_task_id="t-1",
        provider_status="queued",
        provider_snapshot={"task_id": "t-1"},
    )
    assert submitted.status == STATUS_SUBMITTED
    assert submitted.submitted_at is not None

    running = await repo.record_progress(
        job.id, provider_status="running", provider_snapshot={"status": "running"}
    )
    assert running is not None
    assert running.provider_status == "running"
    assert running.status == STATUS_SUBMITTED, "还在跑不改状态"

    completed = await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/v.mp4",
        watermark_output_url="https://cdn.test/v-wm.mp4",
        provider_status="succeeded",
        provider_snapshot={"status": "succeeded"},
    )
    assert completed is not None
    assert completed.finished_at is not None
    assert completed.watermark_output_url == "https://cdn.test/v-wm.mp4"
    assert completed.submitted_at == submitted.submitted_at, "别把发出去的时刻改成拿到结果的时刻"
    assert completed.request == request, "请求体读回来必须还是原来那个"


async def test_sync_result_backfills_the_submitted_moment(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    completed = await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/out.png",
        provider_status="succeeded",
        provider_snapshot={},
        provider_task_id="img-1",
    )
    assert completed is not None
    assert completed.provider_task_id == "img-1", "对账 id 错过这一步就永远没人写它"
    assert completed.submitted_at is not None


async def test_status_guard_never_overwrites_a_real_result(engine: AsyncEngine) -> None:
    """WHERE 状态守卫须阻止延迟的中断清理覆盖已成功的生成结果。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/out.png",
        provider_status="succeeded",
        provider_snapshot={},
    )

    missed = await repo.mark_failed(
        job.id,
        error_code="SUBMIT_INTERRUPTED",
        error_message="不知道发出去没有",
        only_if_status=STATUS_SUBMITTING,
    )
    assert missed is None, "状态已经不是 submitting，这次写入必须一行都不动"

    stored = await repo.get(job.id, owner=owner)
    assert stored.status == STATUS_COMPLETED
    assert stored.output_url == "https://cdn.test/out.png"
    assert stored.error_code is None


async def test_a_late_result_cannot_revive_a_job_that_was_already_failed(
    engine: AsyncEngine,
) -> None:
    """反向也要守住：heal 按心跳判失联不等于原来那次真死了，它回来时不能把失败改回成功。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    await repo.mark_failed(
        job.id, error_code="SUBMIT_INTERRUPTED", error_message="不知道发出去没有"
    )

    missed = await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/late.png",
        provider_status="succeeded",
        provider_snapshot={},
        only_if_status=STATUS_SUBMITTING,
    )
    assert missed is None, "状态已经不是 submitting，这次写入必须一行都不动"

    stored = await repo.get(job.id, owner=owner)
    assert stored.status == STATUS_FAILED
    assert stored.output_url is None


async def test_stage_reports_keep_the_snapshot_and_stop_at_a_conclusion(
    engine: AsyncEngine,
) -> None:
    """阶段上报只写 provider_status：带上快照会把完成时那次写打掉。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    reported = await repo.record_progress(
        job.id, provider_status="processing", only_if_status=STATUS_SUBMITTING
    )
    assert reported is not None
    assert reported.provider_status == "processing"
    assert reported.provider_snapshot is None, "没给快照就不动它"

    await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/out.mp4",
        provider_status="completed",
        provider_snapshot={"durationMs": 4213},
    )
    late = await repo.record_progress(
        job.id, provider_status="uploading", only_if_status=STATUS_SUBMITTING
    )
    assert late is None, "已有结论，迟到的阶段上报不许改它"

    stored = await repo.get(job.id, owner=owner)
    assert stored.provider_status == "completed"
    assert stored.provider_snapshot == {"durationMs": 4213}


async def test_status_guard_lets_the_write_through_when_it_matches(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner)
    await repo.mark_submitting(job.id)

    failed = await repo.mark_failed(
        job.id,
        error_code="SUBMIT_INTERRUPTED",
        error_message="不知道发出去没有",
        only_if_status=STATUS_SUBMITTING,
    )
    assert failed is not None
    assert failed.status == STATUS_FAILED
    assert failed.error_code == "SUBMIT_INTERRUPTED"


async def test_reads_are_scoped_to_the_owner(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    mine = await make_user(engine)
    theirs = await make_user(engine)
    job = await insert_job(repo, theirs)

    with pytest.raises(NotFound):
        await repo.get(job.id, owner=mine)
    assert (await repo.get(job.id, owner=theirs)).id == job.id
    assert (await repo.get(job.id, owner=None)).id == job.id, "治理者视角不过滤"

    assert await repo.list_for_owner(owner=mine, limit=10) == ()
    assert len(await repo.list_for_owner(owner=None, limit=10)) == 1


async def test_origin_round_trips_and_filters_by_conversation(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation_id, task_id = uuid.uuid4(), uuid.uuid4()
    tagged = await repo.create(
        make_job(
            video_request(),
            owner_user_id=owner,
            conversation_id=conversation_id,
            metadata={"path": "video_shot.json", "shot": 3},
            task_id=task_id,
        )
    )
    await insert_job(repo, owner)

    assert (tagged.conversation_id, tagged.metadata, tagged.task_id) == (
        conversation_id,
        {"path": "video_shot.json", "shot": 3},
        task_id,
    )
    read_back = await repo.get(tagged.id, owner=owner)
    assert (read_back.conversation_id, read_back.metadata, read_back.task_id) == (
        conversation_id,
        {"path": "video_shot.json", "shot": 3},
        task_id,
    )

    listed = await repo.list_for_owner(owner=owner, limit=10, conversation_id=conversation_id)
    assert [job.id for job in listed] == [tagged.id]
    by_task = await repo.list_for_owner(owner=owner, limit=10, task_id=task_id)
    assert [job.id for job in by_task] == [tagged.id]
    assert len(await repo.list_for_owner(owner=owner, limit=10)) == 2, "不给就是不筛"


async def test_deleting_the_owner_takes_their_generations_with_it(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner)

    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM iclip.users WHERE id = :id"), {"id": owner})
    with pytest.raises(NotFound):
        await repo.get(job.id, owner=None)


async def test_metadata_containment_filtering_pagination_and_owner_scope(
    engine: AsyncEngine,
) -> None:
    """坐标存 JSONB 列，筛选走 ``@>`` 包含匹配，且在分页截断之前生效。"""

    def coordinate(frame: int) -> dict[str, Any]:
        return {"path": "video_shot.json", "shot": 1, "frame": frame}

    def edit(frame: int, owner_id: uuid.UUID) -> GenerationJob:
        return make_job(
            image_request(metadata=coordinate(frame)),
            owner_user_id=owner_id,
            metadata=coordinate(frame),
        )

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    other = await make_user(engine)
    first = await repo.create(edit(1, owner))
    second = await repo.create(edit(1, owner))
    await repo.create(edit(2, owner))
    foreign = await repo.create(edit(1, other))

    async def page_before(before: uuid.UUID | None = None) -> tuple[GenerationJob, ...]:
        return await repo.list_for_owner(
            owner=owner,
            limit=1,
            kind="image",
            metadata={"shot": 1, "frame": 1},
            before=before,
        )

    page = await page_before()
    assert [job.id for job in page] == [second.id]
    assert page[0].request == second.request
    assert [job.id for job in await page_before(before=second.id)] == [first.id]
    assert await page_before(before=first.id) == ()
    with pytest.raises(NotFound):
        await page_before(before=foreign.id)


async def test_in_flight_by_conversation_summarises_unfinished_video_jobs(
    engine: AsyncEngine,
) -> None:
    """侧栏角标要的摘要：全在排队是 queued，有一条交给上游就是 running，跑完的和图片不算；
    编辑段与合成也是视频行，在跑时对话同样算在出片。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    queued_only, running, settled, images_only, editing, composing = (
        uuid.uuid4() for _ in range(6)
    )

    await repo.create(make_job(video_request(), owner_user_id=owner, conversation_id=queued_only))
    await repo.create(make_job(video_request(), owner_user_id=owner, conversation_id=running))
    submitted = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=running)
    )
    await repo.mark_submitting(submitted.id)
    finished = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=settled)
    )
    await repo.mark_completed(
        finished.id,
        output_url="https://cdn.example.test/a.mp4",
        provider_status="succeeded",
        provider_snapshot={},
    )
    await repo.create(make_job(image_request(), owner_user_id=owner, conversation_id=images_only))
    edit = await repo.create(make_edit(finished, owner_user_id=owner, conversation_id=editing))
    composite = await repo.create(
        make_composite(edit, owner_user_id=owner, conversation_id=composing)
    )
    await repo.mark_submitting(composite.id)

    phases = await repo.in_flight_by_conversation(
        [queued_only, running, settled, images_only, editing, composing, uuid.uuid4()],
        kind="video",
    )

    assert phases == {
        queued_only: "queued",
        running: "running",
        editing: "queued",
        composing: "running",
    }
    assert await repo.in_flight_by_conversation([], kind="video") == {}


async def test_operation_source_and_range_round_trip_and_filter(engine: AsyncEngine) -> None:
    """编辑段与合成的来源、原作、区间落列读回；列表按 operation、source_job_id 筛，与别的筛选叠加收窄。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    edit = await repo.create(
        make_edit(take, owner_user_id=owner, range_start_ms=0, range_end_ms=2500)
    )
    composite = await repo.create(make_composite(edit, owner_user_id=owner))
    other_edit = await repo.create(make_edit(take, owner_user_id=owner))

    read_back = await repo.get(edit.id, owner=owner)
    assert (
        read_back.operation,
        read_back.source_job_id,
        read_back.root_job_id,
        read_back.range_start_ms,
        read_back.range_end_ms,
    ) == ("generate", take.id, take.id, 0, 2500)
    assert read_back.request == edit.request
    stored = await repo.get(composite.id, owner=owner)
    assert (stored.kind, stored.operation, stored.source_job_id, stored.root_job_id) == (
        "video",
        "compose",
        edit.id,
        take.id,
    )
    assert stored.request == composite.request, "合成的各段读回来原样，取到结尾的那段仍是开放的"

    async def listed(**filters: Any) -> set[uuid.UUID]:
        return {job.id for job in await repo.list_for_owner(owner=owner, limit=10, **filters)}

    assert await listed(source_job_id=take.id) == {edit.id, other_edit.id}
    assert await listed(operation="compose") == {composite.id}
    assert await listed(operation="generate", root_job_id=take.id) == {edit.id, other_edit.id}
    assert await listed(operation="generate") == {take.id, edit.id, other_edit.id}


async def test_shot_index_round_trips_and_filters_alongside_the_coordinates(
    engine: AsyncEngine,
) -> None:
    """镜号落列读回；列表按镜号筛，可与坐标、对话叠加收窄，坐标里的同名键不算镜号。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()
    take = await repo.create(
        make_job(
            video_request(),
            owner_user_id=owner,
            conversation_id=conversation,
            shot_index=2,
            metadata={"frame": 1},
        )
    )
    edit = await repo.create(make_edit(take, owner_user_id=owner, conversation_id=conversation))
    other_shot = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=conversation, shot_index=3)
    )
    tagged_only = await repo.create(
        make_job(
            video_request(), owner_user_id=owner, conversation_id=conversation, metadata={"shot": 2}
        )
    )

    assert (await repo.get(take.id, owner=owner)).shot_index == 2
    assert (await repo.get(edit.id, owner=owner)).shot_index == 2
    assert (await repo.get(tagged_only.id, owner=owner)).shot_index is None

    async def listed(**filters: Any) -> set[uuid.UUID]:
        return {job.id for job in await repo.list_for_owner(owner=owner, limit=10, **filters)}

    assert await listed(shot_index=2) == {take.id, edit.id}
    assert await listed(shot_index=2, conversation_id=uuid.uuid4()) == set()
    assert await listed(shot_index=2, metadata={"frame": 1}) == {take.id}
    assert await listed(shot_index=3) == {other_shot.id}
    assert await listed(shot_index=4) == set()


async def test_duration_is_written_only_when_completion_brings_one(engine: AsyncEngine) -> None:
    """时长落列，快照照给的写；完成时没给时长就不动这一列。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    edit = await repo.create(make_edit(take, owner_user_id=owner))
    composite = await repo.create(make_composite(edit, owner_user_id=owner))
    image = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(composite.id)
    measured = await repo.mark_completed(
        composite.id,
        output_url="https://cdn.test/master.mp4",
        provider_status="completed",
        provider_snapshot={},
        duration_ms=7040,
        only_if_status=STATUS_SUBMITTING,
    )
    await repo.mark_completed(
        image.id,
        output_url="https://cdn.test/out.png",
        provider_status="succeeded",
        provider_snapshot={},
    )

    assert measured is not None and measured.duration_ms == 7040
    stored = await repo.get(composite.id, owner=owner)
    assert (stored.duration_ms, stored.provider_snapshot) == (7040, {})
    assert (await repo.get(image.id, owner=owner)).duration_ms is None


_SHAPES = {
    "出片带来源": ("video", "generate", "take", None, None),
    "编辑段缺区间": ("video", "generate", "take", "take", None),
    "编辑段区间倒过来": ("video", "generate", "take", "take", (3000, 1000)),
    "编辑段起点为负": ("video", "generate", "take", "take", (-1, 1000)),
    "合成带区间": ("video", "compose", "edit", "take", (0, 1000)),
    "合成没有来源": ("video", "compose", None, "take", None),
    "图片带原作": ("image", "generate", None, "take", None),
    "kind 是 clip": ("clip", "compose", "edit", "take", None),
    "operation 是 cut": ("image", "cut", None, None, None),
}
"""(kind, operation, 来源, 原作, 区间)；来源与原作写的是种子里哪一条。"""


@pytest.mark.parametrize("shape", list(_SHAPES))
async def test_combined_constraints_refuse_rows_of_no_known_shape(
    engine: AsyncEngine, shape: str
) -> None:
    """每种行的必填与留空由库兜底：绕过受理层直接写，形状对不上也落不进去。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    edit = await repo.create(make_edit(take, owner_user_id=owner))
    seeded = {"take": take.id, "edit": edit.id}
    kind, operation, source, root, span = _SHAPES[shape]

    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, operation, "
                    "provider, request, status, source_job_id, root_job_id, range_start_ms, "
                    "range_end_ms, created_at, updated_at) VALUES (:id, :owner, :kind, :operation, "
                    "'test', CAST(:request AS jsonb), 'pending', :source, :root, :start, :end, "
                    "now(), now())"
                ),
                {
                    "id": uuid.uuid4(),
                    "owner": owner,
                    "kind": kind,
                    "operation": operation,
                    "request": json.dumps({"prompt": "p"}),
                    "source": None if source is None else seeded[source],
                    "root": None if root is None else seeded[root],
                    "start": None if span is None else span[0],
                    "end": None if span is None else span[1],
                },
            )


async def test_a_reference_cut_records_the_actual_range_only_while_submitting(
    engine: AsyncEngine,
) -> None:
    """切好参考片段：区间改记实际切点、阶段词清掉、业务状态不动；这一行不在提交中就一行都不改。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    edit = await repo.create(
        make_edit(take, owner_user_id=owner, range_start_ms=1500, range_end_ms=4000)
    )

    early = await repo.record_reference_cut(
        edit.id, range_start_ms=0, range_end_ms=4000, only_if_status=STATUS_SUBMITTING
    )
    assert early is None, "还没开始提交"
    await repo.mark_submitting(edit.id)
    await repo.record_progress(
        edit.id, provider_status="processing", only_if_status=STATUS_SUBMITTING
    )
    # 起点落在最前面的关键帧上，夹到 0：组合约束仍然认它是一段编辑区间。
    cut = await repo.record_reference_cut(
        edit.id, range_start_ms=0, range_end_ms=4000, only_if_status=STATUS_SUBMITTING
    )
    assert cut is not None
    assert (cut.status, cut.provider_status, cut.range_start_ms, cut.range_end_ms) == (
        STATUS_SUBMITTING,
        None,
        0,
        4000,
    )

    await repo.mark_failed(edit.id, error_code="SUBMIT_INTERRUPTED", error_message="中断了")
    late = await repo.record_reference_cut(
        edit.id, range_start_ms=500, range_end_ms=4000, only_if_status=STATUS_SUBMITTING
    )
    assert late is None, "已有结论，迟到的切点不许改它"
    stored = await repo.get(edit.id, owner=owner)
    assert (stored.range_start_ms, stored.range_end_ms) == (0, 4000)


async def _complete(repo: SqlGenerationRepository, job: GenerationJob, url: str) -> GenerationJob:
    """把一条记录推到终态，使它带上输出地址。"""

    await repo.mark_submitting(job.id)
    await repo.mark_submitted(
        job.id, provider_task_id=str(job.id), provider_status="queued", provider_snapshot={}
    )
    completed = await repo.mark_completed(
        job.id, output_url=url, provider_status="succeeded", provider_snapshot={}
    )
    assert completed is not None
    return completed


# --- 分叉继承 -------------------------------------------------------------------
# 对话行与生成记录都用各自仓储落库，时刻全是数据库时钟：调用的先后就是时刻的先后，
# 边界两侧的记录因此是真的落在两侧，递归血缘查询也一起测到。


async def open_conversation(
    conversations: SqlConversationRepository,
    owner: uuid.UUID,
    *,
    forked_from: uuid.UUID | None = None,
) -> Conversation:
    now = datetime.now(UTC)
    created, _ = await conversations.create_if_absent(
        Conversation(
            id=uuid.uuid4(),
            owner_user_id=owner,
            agent_id="storyboard",
            title="t",
            title_kind="custom",
            last_run_id=None,
            task_id=None,
            collection_id=None,
            created_at=now,
            updated_at=now,
            forked_from=forked_from,
            fork_turn=None if forked_from is None else 1,
        )
    )
    return created


async def finished(
    repo: SqlGenerationRepository,
    owner: uuid.UUID,
    conversation_id: uuid.UUID,
    name: str,
    request: GenerationRequest | None = None,
    **fields: Any,
) -> GenerationJob:
    """在这段对话里出一条已完成的记录，地址按 ``name`` 起。"""

    job = await repo.create(
        make_job(
            request or video_request(),
            owner_user_id=owner,
            conversation_id=conversation_id,
            **fields,
        )
    )
    return await _complete(repo, job, f"https://example.test/{name}.mp4")


async def test_each_hop_has_its_own_boundary_and_only_finished_takes_are_inherited(
    engine: AsyncEngine,
) -> None:
    """孙对话继承父对话在孙建立前完成的，和祖父在父建立前完成的；边界不是一刀切在孙的建立时刻。

    分叉那一刻还在跑、之后才完成的不算，失败的也不算；编辑段是一行普通的完成记录，照样继承。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    grand = await open_conversation(conversations, author)
    from_grand = await finished(repo, author, grand.id, "grand-early")
    parent = await open_conversation(conversations, author, forked_from=grand.id)
    await finished(repo, author, grand.id, "grand-after-parent")
    from_parent = await finished(repo, author, parent.id, "parent-early")
    in_flight = await repo.create(
        make_job(video_request(), owner_user_id=author, conversation_id=parent.id)
    )
    parent_edit = await finished(
        repo,
        author,
        parent.id,
        "parent-edit",
        edit_request(),
        source_job_id=from_parent.id,
        root_job_id=from_parent.id,
        range_start_ms=1000,
        range_end_ms=4000,
    )
    failed = await repo.create(
        make_job(video_request(), owner_user_id=author, conversation_id=parent.id)
    )
    await repo.mark_failed(failed.id, error_code="UPSTREAM_FAILED", error_message="上游拒了")
    child = await open_conversation(conversations, forker, forked_from=parent.id)
    await _complete(repo, in_flight, "https://example.test/in-flight.mp4")
    await finished(repo, author, parent.id, "parent-after-child")
    own = await finished(repo, forker, child.id, "child-own")

    inheritance = await conversations.ancestry(child.id)
    assert inheritance == ((parent.id, child.created_at), (grand.id, parent.created_at)), (
        "近的祖先在前，边界是这条链上它的下一级对话的建立时刻"
    )
    listed = await repo.list_for_owner(
        owner=forker, limit=20, conversation_id=child.id, inherited=inheritance
    )
    assert {job.id for job in listed} == {own.id, from_parent.id, parent_edit.id, from_grand.id}
    assert {
        job.id
        for job in await repo.list_for_owner(owner=forker, limit=20, conversation_id=child.id)
    } == {own.id}, "不给边界对就只按属主"
    assert await conversations.ancestry(grand.id) == (), "不是分叉来的没有祖先"


async def test_ancestry_walks_through_a_deleted_source(engine: AsyncEngine) -> None:
    """源对话删成墓碑，副本从它那里继承的出片照旧在。"""

    conversations = SqlConversationRepository(engine)
    author = await make_user(engine)
    source = await open_conversation(conversations, author)
    copy = await open_conversation(conversations, author, forked_from=source.id)
    await conversations.delete(source.id, owner=author)

    assert await conversations.ancestry(copy.id) == ((source.id, copy.created_at),)


async def test_inherited_records_keep_their_facts_and_obey_the_other_filters(
    engine: AsyncEngine,
) -> None:
    """继承只是读得到：属主与所在对话不变。按原作、来源、种类、操作与坐标筛时，继承来的与自己的
    一视同仁。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    source = await open_conversation(conversations, author)
    root = await finished(repo, author, source.id, "root", metadata={"shot": 1})
    await finished(repo, author, source.id, "other-shot", metadata={"shot": 2})
    edited = await finished(
        repo,
        author,
        source.id,
        "edited",
        edit_request(),
        source_job_id=root.id,
        root_job_id=root.id,
        range_start_ms=1000,
        range_end_ms=4000,
    )
    master = await finished(
        repo,
        author,
        source.id,
        "master",
        compose_request(),
        provider="ffmpeg",
        source_job_id=edited.id,
        root_job_id=root.id,
    )
    copy = await open_conversation(conversations, forker, forked_from=source.id)
    own_master = await finished(
        repo,
        forker,
        copy.id,
        "own-master",
        compose_request(),
        provider="ffmpeg",
        source_job_id=edited.id,
        root_job_id=root.id,
    )
    inheritance = await conversations.ancestry(copy.id)

    async def listed(**filters: Any) -> set[uuid.UUID]:
        found = await repo.list_for_owner(
            owner=forker, limit=20, conversation_id=copy.id, inherited=inheritance, **filters
        )
        return {job.id for job in found}

    assert await listed(root_job_id=root.id) == {edited.id, master.id, own_master.id}
    assert await listed(source_job_id=edited.id) == {master.id, own_master.id}
    assert await listed(operation="compose") == {master.id, own_master.id}
    assert await listed(kind="video", metadata={"shot": 1}) == {root.id}
    inherited_root = await repo.get(root.id, owner=forker, inherited=inheritance)
    assert (inherited_root.conversation_id, inherited_root.owner_user_id) == (source.id, author)


async def test_pages_turn_on_an_inherited_anchor_and_reads_stop_at_the_boundary(
    engine: AsyncEngine,
) -> None:
    """按对话翻页时上一页最后一条可能是继承来的，锚点要读得到它；边界之后的仍然读不到。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    source = await open_conversation(conversations, author)
    older = await finished(repo, author, source.id, "older")
    newer = await finished(repo, author, source.id, "newer")
    copy = await open_conversation(conversations, forker, forked_from=source.id)
    too_late = await finished(repo, author, source.id, "too-late")
    own = await finished(repo, forker, copy.id, "own")
    inheritance = await conversations.ancestry(copy.id)

    pages: list[uuid.UUID] = []
    before: uuid.UUID | None = None
    while page := await repo.list_for_owner(
        owner=forker, limit=1, conversation_id=copy.id, before=before, inherited=inheritance
    ):
        pages.append(page[0].id)
        before = page[0].id
    assert pages == [own.id, newer.id, older.id]

    with pytest.raises(NotFound):
        await repo.get(newer.id, owner=forker)
    with pytest.raises(NotFound):
        await repo.get(too_late.id, owner=forker, inherited=inheritance)
