"""验证生成仓储的数据库时钟、JSON 往返、外键、组合约束、条件更新原子性与分叉继承的读范围。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.common.errors import NotFound
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationOperation,
)
from iclip.domains.generation.schemas import GenerationRequest
from tests.helpers.fork_lineage import (
    complete,
    finished,
    make_user,
    open_conversation,
    three_level_fork,
)
from tests.helpers.generation import (
    compose_request,
    edit_request,
    image_request,
    make_composite,
    make_cut,
    make_edit,
    make_job,
    make_upload,
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
    submitted = await repo.mark_submitted(job.id, provider_task_id="t-1", provider_status="queued")
    assert submitted.status == STATUS_SUBMITTED
    assert submitted.submitted_at is not None

    running = await repo.record_progress(job.id, provider_status="running")
    assert running is not None
    assert running.provider_status == "running"
    assert running.status == STATUS_SUBMITTED, "还在跑不改状态"

    completed = await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/v.mp4",
        watermark_output_url="https://cdn.test/v-wm.mp4",
        provider_status="succeeded",
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
        job.id, output_url="https://cdn.test/out.png", provider_status="succeeded"
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
        only_if_status=STATUS_SUBMITTING,
    )
    assert missed is None, "状态已经不是 submitting，这次写入必须一行都不动"

    stored = await repo.get(job.id, owner=owner)
    assert stored.status == STATUS_FAILED
    assert stored.output_url is None


async def test_stage_reports_stop_at_a_conclusion(engine: AsyncEngine) -> None:
    """阶段上报只写 provider_status；已有结论后，迟到的上报不许改它。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    reported = await repo.record_progress(
        job.id, provider_status="processing", only_if_status=STATUS_SUBMITTING
    )
    assert reported is not None
    assert reported.provider_status == "processing"

    await repo.mark_completed(
        job.id, output_url="https://cdn.test/out.mp4", provider_status="completed"
    )
    late = await repo.record_progress(
        job.id, provider_status="uploading", only_if_status=STATUS_SUBMITTING
    )
    assert late is None, "已有结论，迟到的阶段上报不许改它"

    stored = await repo.get(job.id, owner=owner)
    assert stored.provider_status == "completed"


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
        finished.id, output_url="https://cdn.example.test/a.mp4", provider_status="succeeded"
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
    """时长落列；完成时没给时长就不动这一列。"""

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
        duration_ms=7040,
        only_if_status=STATUS_SUBMITTING,
    )
    await repo.mark_completed(
        image.id, output_url="https://cdn.test/out.png", provider_status="succeeded"
    )

    assert measured is not None and measured.duration_ms == 7040
    stored = await repo.get(composite.id, owner=owner)
    assert stored.duration_ms == 7040
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
    "operation 不认识": ("image", "crop", None, None, None),
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
                    "range_end_ms, created_at) VALUES (:id, :owner, :kind, :operation, "
                    "'test', CAST(:request AS jsonb), 'pending', :source, :root, :start, :end, "
                    "now())"
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


_BASE_URL = "https://example.test/base.png"

_IMAGE_ROW: dict[str, Any] = {
    "kind": "image",
    "operation": "generate",
    "request": '{"prompt": "p"}',
    "status": "pending",
    "conversation": False,
    "source": False,
    "source_url": None,
    "root": False,
    "output_url": None,
    "finished": False,
}
"""一条合法的图片生成；各用例在它上面改几列，``conversation`` / ``source`` / ``root`` 为真就填上。"""

_SETTLED: dict[str, Any] = {
    "request": None,
    "status": "completed",
    "output_url": "https://example.test/settled.png",
    "finished": True,
}
"""创建即完成的行：没有请求，已完成，有产物地址与完成时刻。"""

_REFUSED_SHAPES: dict[str, dict[str, Any]] = {
    "切图没有来源": {"operation": "cut", **_SETTLED},
    "切图带外部地址": {"operation": "cut", "source": True, "source_url": _BASE_URL, **_SETTLED},
    "视频切图": {"kind": "video", "operation": "cut", "source": True, **_SETTLED},
    "上传带来源": {"operation": "upload", "source": True, **_SETTLED},
    "上传挂对话": {"operation": "upload", "conversation": True, **_SETTLED},
    "上传带请求": {"operation": "upload", **_SETTLED, "request": '{"prompt": "p"}'},
    "上传的请求是 JSON null": {"operation": "upload", **_SETTLED, "request": "null"},
    "出图没有请求": {"request": None},
    "出图的请求是 JSON null": {"request": "null"},
    "帧图编辑两种来源都填": {"source": True, "source_url": _BASE_URL},
    "视频带外部地址": {"kind": "video", "source_url": _BASE_URL},
    "切图还没完成": {"operation": "cut", "source": True, "request": None},
    "上传没有产物地址": {"operation": "upload", **_SETTLED, "output_url": None},
    "上传没有完成时刻": {"operation": "upload", **_SETTLED, "finished": False},
    "图片合成": {
        "operation": "compose",
        "source": True,
        "root": True,
        "request": '{"segments": []}',
    },
}

_ACCEPTED_SHAPES: dict[str, dict[str, Any]] = {
    "帧图编辑记库内底图": {"source": True},
    "帧图编辑记外部底图": {"source_url": _BASE_URL},
    "切图": {"operation": "cut", "source": True, "conversation": True, **_SETTLED},
    "图片上传": {"operation": "upload", **_SETTLED},
    "视频上传": {"kind": "video", "operation": "upload", **_SETTLED},
}


async def _insert_shaped(engine: AsyncEngine, shape: Mapping[str, Any]) -> None:
    """绕过受理层直接写一行；来源与原作指一张现成的图。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    grid = await repo.create(make_job(image_request(), owner_user_id=owner))
    row = {**_IMAGE_ROW, **shape}
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind, "
                "operation, provider, request, status, source_job_id, source_url, root_job_id, "
                "output_url, created_at, finished_at) VALUES (:id, :owner, "
                ":conversation, :kind, :operation, 'test', CAST(:request AS jsonb), :status, "
                ":source, :source_url, :root, :output_url, now(), :finished_at)"
            ),
            {
                "id": uuid.uuid4(),
                "owner": owner,
                "conversation": uuid.uuid4() if row["conversation"] else None,
                "kind": row["kind"],
                "operation": row["operation"],
                "request": row["request"],
                "status": row["status"],
                "source": grid.id if row["source"] else None,
                "source_url": row["source_url"],
                "root": grid.id if row["root"] else None,
                "output_url": row["output_url"],
                "finished_at": datetime.now(UTC) if row["finished"] else None,
            },
        )


@pytest.mark.parametrize("shape", list(_REFUSED_SHAPES))
async def test_sources_and_settled_rows_of_no_known_shape_are_refused(
    engine: AsyncEngine, shape: str
) -> None:
    """帧图编辑、切图、上传的必填与留空也由库兜底；请求为 JSON null 与 SQL NULL 一样挡得住。"""

    with pytest.raises(IntegrityError):
        await _insert_shaped(engine, _REFUSED_SHAPES[shape])


@pytest.mark.parametrize("shape", list(_ACCEPTED_SHAPES))
async def test_sources_and_settled_rows_of_a_known_shape_are_accepted(
    engine: AsyncEngine, shape: str
) -> None:
    await _insert_shaped(engine, _ACCEPTED_SHAPES[shape])


async def test_settled_rows_land_once_on_the_database_clock_without_a_request(
    engine: AsyncEngine,
) -> None:
    """创建即完成的几行一次落：与输入同序，建立与完成是数据库时钟的同一刻，请求是 SQL NULL。
    同 id 再落一次跳过、不覆盖，返回值里没有它。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    stale = datetime.now(UTC) - timedelta(days=365)
    grid = await finished(repo, owner, uuid.uuid4(), "grid", image_request())
    upload = make_upload(owner_user_id=owner, created_at=stale, finished_at=stale)
    cells = [make_cut(grid), make_cut(grid)]

    landed = await repo.create_settled([upload, *cells])
    again = await repo.create_settled(
        [replace(upload, output_url="https://example.test/replaced.png")]
    )

    assert [job.id for job in landed] == [upload.id, *(cell.id for cell in cells)]
    assert again == ()
    stored = await repo.get(upload.id, owner=None)
    assert (stored.operation, stored.request, stored.output_url) == (
        "upload",
        None,
        upload.output_url,
    )
    assert stored.created_at == stored.finished_at
    assert stored.created_at > stale + timedelta(days=1), "应用传进来的时刻被数据库改写了"
    async with engine.connect() as conn:
        nulls = (
            await conn.execute(
                text(
                    "SELECT bool_and(request IS NULL) FROM iclip.generation_jobs "
                    "WHERE operation IN ('cut', 'upload')"
                )
            )
        ).scalar_one()
    assert nulls is True, "没有请求落的是 SQL NULL，不是 JSON null"


async def test_an_image_is_found_by_its_address_within_the_conversation_and_what_it_inherits(
    engine: AsyncEngine,
) -> None:
    """按产物地址找图片：本对话按属主收敛的、经继承读得到的；没有对话就只找没有对话的；给了操作
    只找那一种；未完成的、视频、别的对话、边界之后的都找不到；对上多条取最早建立的。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker, stranger = [await make_user(engine) for _ in range(3)]
    source = await open_conversation(conversations, author)
    early = await finished(repo, author, source.id, "early", image_request())
    copy = await open_conversation(conversations, forker, forked_from=source.id)
    late = await finished(repo, author, source.id, "late", image_request())
    own = await finished(repo, forker, copy.id, "own", image_request())
    twin = await finished(repo, forker, copy.id, "twin", image_request())
    elsewhere = await finished(repo, forker, uuid.uuid4(), "elsewhere", image_request())
    take = await finished(repo, forker, copy.id, "take")
    loose = await complete(
        repo,
        await repo.create(make_job(image_request(), owner_user_id=forker)),
        "https://example.test/loose.png",
    )
    (upload,) = await repo.create_settled(
        [make_upload(owner_user_id=forker, output_url="https://example.test/upload.png")]
    )
    broken = await repo.create(
        make_job(image_request(), owner_user_id=forker, conversation_id=copy.id)
    )
    await repo.mark_failed(broken.id, error_code="UPSTREAM_FAILED", error_message="上游拒了")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.generation_jobs SET output_url = :url WHERE id = :id"),
            {"url": "https://example.test/broken.png", "id": broken.id},
        )
        await conn.execute(
            text("UPDATE iclip.generation_jobs SET output_url = :url WHERE id = :id"),
            {"url": own.output_url, "id": twin.id},
        )
    inheritance = await conversations.ancestry(copy.id)

    async def find(
        job_url: str | None,
        *,
        owner: uuid.UUID | None = forker,
        conversation_id: uuid.UUID | None = copy.id,
        operation: GenerationOperation | None = None,
    ) -> uuid.UUID | None:
        assert job_url is not None
        found = await repo.find_image_by_output(
            job_url,
            owner=owner,
            conversation_id=conversation_id,
            inherited=inheritance if conversation_id == copy.id else (),
            operation=operation,
        )
        return None if found is None else found.id

    assert await find(own.output_url) == own.id, "同一地址两条，取最早建立的"
    assert await find(early.output_url) == early.id, "边界之内继承来的"
    assert await find(late.output_url) is None, "分叉之后才完成的不继承"
    assert await find(elsewhere.output_url) is None
    assert await find(take.output_url) is None, "视频不是图片"
    assert await find("https://example.test/broken.png") is None, "没完成的不算"
    assert await find(own.output_url, owner=stranger) is None, "别人的按属主筛掉"
    assert await find(own.output_url, owner=None) == own.id, "不限属主就读得到"
    assert await find(loose.output_url) is None, "没有对话的行不在这段对话里"
    assert await find(loose.output_url, conversation_id=None) == loose.id
    assert await find(upload.output_url, conversation_id=None, operation="upload") == upload.id
    assert await find(loose.output_url, conversation_id=None, operation="upload") is None


async def test_output_urls_answer_only_for_rows_that_have_one(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    done = await finished(repo, owner, uuid.uuid4(), "done", image_request())
    pending = await insert_job(repo, owner, image_request())

    assert await repo.output_urls([]) == {}
    assert await repo.output_urls([done.id, pending.id, uuid.uuid4()]) == {done.id: done.output_url}


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


# --- 分叉继承 -------------------------------------------------------------------
# 场景与构造器在 tests/helpers/fork_lineage.py，资料库的集成测试用同一个场景。


async def test_each_hop_has_its_own_boundary_and_only_finished_takes_are_inherited(
    engine: AsyncEngine,
) -> None:
    """孙对话继承父对话在孙建立前完成的，和祖父在父建立前完成的；边界不是一刀切在孙的建立时刻。

    分叉那一刻还在跑、之后才完成的不算，失败的也不算；编辑段是一行普通的完成记录，照样继承。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    chain = await three_level_fork(engine)
    grand, parent, child = chain.grand, chain.parent, chain.child

    inheritance = await conversations.ancestry(child.id)
    assert inheritance == ((parent.id, child.created_at), (grand.id, parent.created_at)), (
        "近的祖先在前，边界是这条链上它的下一级对话的建立时刻"
    )
    listed = await repo.list_for_owner(
        owner=chain.forker, limit=20, conversation_id=child.id, inherited=inheritance
    )
    assert {job.id for job in listed} == {
        chain.own.id,
        chain.from_parent.id,
        chain.parent_edit.id,
        chain.from_grand.id,
    }
    assert {
        job.id
        for job in await repo.list_for_owner(owner=chain.forker, limit=20, conversation_id=child.id)
    } == {chain.own.id}, "不给边界对就只按属主"
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
