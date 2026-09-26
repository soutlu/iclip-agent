"""验证对话分叉：副本拷什么、继承什么、源保持不变、谁分得动、什么时候分不动。

默认的 app 没装媒体生成；出片记录的继承另装一个开了媒体生成的 app 走一遍端到端，
边界、筛选与翻页的细节在 [生成仓储测试](../generation/test_generation_repository_pg.py) 里验。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import NoReturn

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, RunRecord, StepEvent
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.common.errors import Conflict, NotFound
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.service import ConversationService
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob
from iclip.domains.identity.public import Principal
from iclip.harness.step_store_pg import PgStepStore
from tests.helpers.app import make_client
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.generation import (
    MEDIA_ENVS,
    MemoryObjectStore,
    config_with_media,
    make_job,
    video_request,
)
from tests.helpers.pg import connected, reset_database

URL = "/conversations"
AGENT_ID = "storyboard"
BASE = datetime(2026, 9, 1, tzinfo=UTC)


async def login_as(
    client: httpx.AsyncClient, pg_url: str, *, username: str, role: str = "editor"
) -> str:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, [role])
    return user_id


async def open_conversation(client: httpx.AsyncClient, **body: object) -> str:
    opened = await client.post(URL, json={"agentId": AGENT_ID, **body})
    assert opened.status_code == 201, opened.text
    return opened.json()["conversation"]["id"]


async def seed_turns(pg_url: str, conversation_id: str, prompts: list[str]) -> list[str]:
    """给对话造出几轮已跑完的历史，返回各轮的 run id。

    没有 agent_jobs 映射时每个 run 自成一轮，正是副本读继承轮的样子。
    """

    engine = create_async_engine(pg_url)
    run_ids: list[str] = []
    try:
        store = PgStepStore(engine)
        messages: list[ModelRequest | ModelResponse] = []
        for index, prompt in enumerate(prompts):
            run_id = f"{AGENT_ID}-{uuid.uuid4().hex[:8]}"
            run_ids.append(run_id)
            at = BASE + timedelta(minutes=index)
            await store.register_run(RunRecord(run_id=run_id, conversation_id=conversation_id))
            await store.append_event(
                StepEvent(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    kind="run_completed",
                    step_index=1,
                )
            )
            messages.append(
                ModelRequest(parts=[UserPromptPart(prompt, timestamp=at)], run_id=run_id)
            )
            messages.append(
                ModelResponse(parts=[TextPart(f"收到：{prompt}")], timestamp=at, run_id=run_id)
            )
            await store.save_snapshot(
                ContinuableSnapshot(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    step_index=1,
                    messages=list(messages),
                )
            )
    finally:
        await engine.dispose()
    return run_ids


async def seed_side_data(pg_url: str, namespace: str) -> None:
    """工作区文件与素材台账各放一条，两者都按命名空间隔离。"""

    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.workspace_files"
                " (namespace, path, content, version, created_at, updated_at)"
                " VALUES (:ns, 'video_shot.json', :content, 3, now(), now())"
            ),
            {"ns": namespace, "content": '{"shots": []}'},
        )
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.materials (namespace, url, kind)"
                " VALUES (:ns, 'https://example.test/ref.mp4', 'video')"
            ),
            {"ns": namespace},
        )


async def side_data(pg_url: str, namespace: str) -> tuple[list[str], list[str]]:
    async with connected(pg_url) as conn:
        paths = list(
            (
                await conn.execute(
                    text(
                        "SELECT path FROM agent_runtime.workspace_files"
                        " WHERE namespace = :ns ORDER BY path"
                    ),
                    {"ns": namespace},
                )
            ).scalars()
        )
        urls = list(
            (
                await conn.execute(
                    text(
                        "SELECT url FROM agent_runtime.materials WHERE namespace = :ns ORDER BY url"
                    ),
                    {"ns": namespace},
                )
            ).scalars()
        )
    return paths, urls


async def fork(client: httpx.AsyncClient, conversation_id: str, **body: object) -> httpx.Response:
    return await client.post(f"{URL}/{conversation_id}:fork", json={"turn": 1, **body})


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("分叉用不到这个端口")


class StartMovedUnderUs:
    """起点端口的替身：源闲着、有一轮，可写种子快照时报源变了。"""

    def __init__(self) -> None:
        self.targets: list[uuid.UUID] = []

    async def idle(self, conversation_id: uuid.UUID) -> bool:
        return True

    async def turn_count(self, conversation_id: uuid.UUID) -> int:
        return 1

    async def seed(self, *, source_id: uuid.UUID, target_id: uuid.UUID, turn: int) -> bool:
        self.targets.append(target_id)
        return False


async def copy_no_workspace(
    *, source_owner: uuid.UUID, source_id: uuid.UUID, target_owner: uuid.UUID, target_id: uuid.UUID
) -> None:
    return None


async def test_fork_carries_history_and_workspace_and_leaves_the_source_alone(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as(client, pg_url, username="luke")
    source = await open_conversation(client, title="开场那段")
    await seed_turns(pg_url, source, ["第一句", "第二句", "第三句"])
    await seed_side_data(pg_url, f"{owner}/{source}")

    forked = await fork(client, source, turn=2)
    assert forked.status_code == 201, forked.text
    copy = forked.json()["conversation"]
    assert copy["forkedFrom"] == source
    assert copy["forkTurn"] == 2
    assert copy["ownerUserId"] == owner
    assert copy["agentId"] == AGENT_ID
    assert copy["title"] == "开场那段（分叉 · 第 2 轮）"
    assert copy["taskId"] is None, "挂上源的需求单就等于替别人认领"

    history = await client.get(f"{URL}/{copy['id']}/transcript")
    assert history.status_code == 200, history.text
    assert (history.json()["forked_from"], history.json()["fork_turn"]) == (source, 2), (
        "会话页首屏靠这两项画血缘提示"
    )
    turns = history.json()["items"]
    assert [turn["content"] for turn in turns] == [
        [{"type": "text", "text": "第一句"}],
        [{"type": "text", "text": "第二句"}],
    ], "继承轮要读得出来，而且截在分叉点上"
    assert [turn["state"] for turn in turns] == ["completed", "completed"], (
        "终态是拿原 run id 回源查的，副本没存运行记录"
    )

    assert await side_data(pg_url, f"{owner}/{copy['id']}") == (
        ["video_shot.json"],
        ["https://example.test/ref.mp4"],
    )
    source_history = await client.get(f"{URL}/{source}/transcript")
    assert len(source_history.json()["items"]) == 3, "源对话的历史不能被分叉动到"
    assert await side_data(pg_url, f"{owner}/{source}") == (
        ["video_shot.json"],
        ["https://example.test/ref.mp4"],
    )


async def test_fork_copies_the_file_but_not_its_version(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """副本的文件从第 1 版起：源的版本号是给源那份乐观锁用的，跟着搬会让副本的首次写对不上。"""

    owner = await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句"])
    await seed_side_data(pg_url, f"{owner}/{source}")

    copy = (await fork(client, source)).json()["conversation"]["id"]

    read = await client.get(f"{URL}/{copy}/workspace/file", params={"path": "video_shot.json"})
    assert read.status_code == 200, read.text
    assert read.json()["file"]["version"] == 1


async def test_agent_id_can_be_swapped_for_a_side_by_side_run(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句"])

    copy = (await fork(client, source, agentId="assistant")).json()["conversation"]
    assert copy["agentId"] == "assistant"


async def test_governor_forks_anyone_including_tombstones(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句"])
    await seed_side_data(pg_url, f"{owner}/{source}")
    assert (await client.delete(f"{URL}/{source}")).status_code == 204

    async with make_client(app) as governor:
        boss = await login_as(governor, pg_url, username="root", role="root")
        forked = await fork(governor, source)
        assert forked.status_code == 201, forked.text
        copy = forked.json()["conversation"]
        assert copy["ownerUserId"] == boss
        assert copy["deletedAt"] is None, "副本是活的，墓碑只是它的来源"
        assert await side_data(pg_url, f"{boss}/{copy['id']}") == (
            ["video_shot.json"],
            ["https://example.test/ref.mp4"],
        )

    assert (await fork(client, source)).status_code == 404, "属主自己也看不见墓碑"


async def test_invisible_source_is_404(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句"])

    async with make_client(app) as other:
        await login_as(other, pg_url, username="mia")
        assert (await fork(other, source)).status_code == 404
        assert (await fork(other, str(uuid.uuid4()))).status_code == 404


@pytest.mark.parametrize("turn", [0, -1])
async def test_turn_must_be_a_positive_number(
    client: httpx.AsyncClient, pg_url: str, turn: int
) -> None:
    await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句"])

    assert (await fork(client, source, turn=turn)).status_code == 422


async def test_turn_beyond_the_end_and_conversations_that_never_ran_are_422(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as(client, pg_url, username="luke")
    never_ran = await open_conversation(client)
    assert (await fork(client, never_ran)).status_code == 422

    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句", "第二句"])
    assert (await fork(client, source, turn=2)).status_code == 201
    assert (await fork(client, source, turn=3)).status_code == 422


async def test_source_with_an_unfinished_prompt_is_409(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """排队中的那条一旦起跑就会写新快照，轮号跟着变，分叉点会指到别的地方去。"""

    owner = await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句"])
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.agent_jobs"
                " (prompt_id, conversation_id, agent_id, owner_user_id, user_name,"
                "  content, status, created_at)"
                " VALUES (:pid, :cid, :agent, :owner, 'luke', '[]', 'queued', now())"
            ),
            {
                "pid": f"prm_{uuid.uuid4().hex[:16]}",
                "cid": source,
                "agent": AGENT_ID,
                "owner": owner,
            },
        )

    assert (await fork(client, source)).status_code == 409


async def test_start_moving_between_counting_and_seeding_voids_the_fork(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """数完轮数到写种子快照之间源变了，起点端口回 False：这次分叉作废，对话行不落库。

    HTTP 层造不出这个间隙，直接装配用例：仓储用真的，起点端口用一个报「源变了」的替身，
    分叉用不到的端口一碰就报错。中途失败只留下寻址不到的副本数据，见 architecture.md §4 对话分叉。
    """

    owner = await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    start = StartMovedUnderUs()
    engine = create_async_engine(pg_url)
    try:
        repo = SqlConversationRepository(engine)
        service = ConversationService(
            repo,
            list_collections=_untouched,
            claim_task=_untouched,
            list_derived_files=_untouched,
            read_derived_file=_untouched,
            write_derived_file=_untouched,
            document_validators={},
            generate_title=_untouched,
            announce_title=_untouched,
            activities_of=_untouched,
            busy_conversation_ids=_untouched,
            fork_transcript=start,
            copy_workspace=copy_no_workspace,
        )
        principal = Principal(
            kind="user", user_id=uuid.UUID(owner), permissions=frozenset(), audit_label="luke"
        )

        with pytest.raises(Conflict):
            await service.fork(principal, uuid.UUID(source), turn=1)

        [target] = start.targets
        with pytest.raises(NotFound):
            await repo.get(target, owner=None, include_deleted=True)
    finally:
        await engine.dispose()


async def test_a_fork_of_a_fork_points_at_its_direct_parent(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句", "第二句"])

    first = (await fork(client, source, turn=2)).json()["conversation"]["id"]
    second = (await fork(client, first, turn=1)).json()["conversation"]
    assert second["forkedFrom"] == first
    assert second["forkTurn"] == 1


async def test_inherited_turns_cannot_be_regenerated(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """继承轮是照片，副本下没有它们对应的消息行；往后接着说才是副本自己的轮。"""

    await login_as(client, pg_url, username="luke")
    source = await open_conversation(client)
    await seed_turns(pg_url, source, ["第一句"])

    copy = (await fork(client, source)).json()["conversation"]["id"]
    retried = await client.post(f"{URL}/{copy}/turns/t1:regenerate", json={})
    assert retried.status_code == 404, retried.text


@pytest.fixture
async def media_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[FastAPI]:
    """开了媒体生成的 app：对象存储与队列连接器用替身，受理只落库、不外呼。"""

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    async with connected(migrated_pg) as conn:
        await reset_database(conn)
    engine = create_async_engine(migrated_pg)
    try:
        yield build_app(
            config_with_media(),
            engine=engine,
            object_store=MemoryObjectStore(),
            queue_connector=InMemoryConnector(),
        )
    finally:
        await engine.dispose()


async def complete(repo: SqlGenerationRepository, job: GenerationJob, name: str) -> GenerationJob:
    await repo.mark_submitting(job.id)
    done = await repo.mark_completed(
        job.id,
        output_url=f"https://example.test/{name}.mp4",
        provider_status="succeeded",
    )
    assert done is not None
    return done


async def generation_count(pg_url: str) -> int:
    async with connected(pg_url) as conn:
        return int(
            (await conn.execute(text("SELECT count(*) FROM iclip.generation_jobs"))).scalar_one()
        )


async def listed_ids(client: httpx.AsyncClient, conversation_id: str) -> set[str]:
    listed = await client.get("/generations", params={"conversationId": conversation_id})
    assert listed.status_code == 200, listed.text
    return {item["id"] for item in listed.json()["items"]}


async def test_a_fork_inherits_finished_takes_instead_of_copying_them(
    media_app: FastAPI, pg_url: str
) -> None:
    """分叉不往生成表里写一行；副本按对话列记录时带上源在分叉前完成的，剪片时拿它当原作。

    分叉那一刻还在跑的、分叉之后才出的都不归副本，同一个人按属主读得到也不行；
    读不到副本的人拿副本 id 什么也列不出来。"""

    engine = create_async_engine(pg_url)
    repo = SqlGenerationRepository(engine)
    try:
        async with make_client(media_app) as client:
            owner = uuid.UUID(await login_as(client, pg_url, username="luke"))
            source = await open_conversation(client)
            await seed_turns(pg_url, source, ["第一句"])
            take = await complete(
                repo,
                await repo.create(
                    make_job(
                        video_request(), owner_user_id=owner, conversation_id=uuid.UUID(source)
                    )
                ),
                "take",
            )
            in_flight = await repo.create(
                make_job(video_request(), owner_user_id=owner, conversation_id=uuid.UUID(source))
            )
            written = await generation_count(pg_url)

            forked = await fork(client, source)
            assert forked.status_code == 201, forked.text
            copy = forked.json()["conversation"]["id"]
            assert await generation_count(pg_url) == written, "分叉不拷出片记录"
            await complete(repo, in_flight, "in-flight")
            after = await complete(
                repo,
                await repo.create(
                    make_job(
                        video_request(), owner_user_id=owner, conversation_id=uuid.UUID(source)
                    )
                ),
                "after",
            )

            assert await listed_ids(client, copy) == {str(take.id)}

            async def edit_on(base: uuid.UUID) -> httpx.Response:
                return await client.post(
                    "/generations/video-edits",
                    json={
                        "source_job_id": str(base),
                        "range_start_ms": 1000,
                        "range_end_ms": 3000,
                        "model": "seedance",
                        "prompt": "换一双鞋",
                        "conversation_id": copy,
                    },
                )

            accepted = await edit_on(take.id)
            assert accepted.status_code == 202, accepted.text
            edit = accepted.json()["generation"]
            assert (edit["sourceJobId"], edit["rootJobId"]) == (str(take.id), str(take.id)), (
                "来源与原作都指源对话那条"
            )
            for outside in (after.id, in_flight.id):
                refused = await edit_on(outside)
                assert refused.status_code == 422, refused.text
            # 编辑段还在排队、不可能是继承来的：列得出来就说明它记在副本名下。
            assert await listed_ids(client, copy) == {str(take.id), edit["id"]}
            assert edit["id"] not in await listed_ids(client, source)

        async with make_client(media_app) as other:
            await login_as(other, pg_url, username="mia")
            assert await listed_ids(other, copy) == set()
    finally:
        await engine.dispose()
