"""分叉继承的共用场景：对话行与生成记录都经各自仓储落库，时刻全是数据库时钟。

调用的先后就是时刻的先后，边界两侧的记录因此是真的落在两侧。生成仓储与资料库各自实现了一份
继承规则，两边的集成测试都用 ``three_level_fork`` 这一个场景，规则漂了会在其中一边现形。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.models import Conversation
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import GenerationRequest
from tests.helpers.generation import edit_request, make_job, video_request


async def make_user(engine: AsyncEngine) -> uuid.UUID:
    """先创建用户以满足 generation_jobs 的属主外键；账号没有用户名。"""

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


async def complete(repo: SqlGenerationRepository, job: GenerationJob, url: str) -> GenerationJob:
    """把一条记录推到终态，使它带上输出地址。"""

    await repo.mark_submitting(job.id)
    await repo.mark_submitted(job.id, provider_task_id=str(job.id), provider_status="queued")
    completed = await repo.mark_completed(job.id, output_url=url, provider_status="succeeded")
    assert completed is not None
    return completed


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
    return await complete(repo, job, f"https://example.test/{name}.mp4")


@dataclass(frozen=True, slots=True)
class ForkChain:
    """祖父 → 父 → 孙三段对话与各自名下的记录，按落库先后列出。"""

    author: uuid.UUID
    """祖父与父的属主。"""
    forker: uuid.UUID
    """分叉出孙的人，孙的属主。"""
    grand: Conversation
    parent: Conversation
    child: Conversation
    from_grand: GenerationJob
    """祖父名下、父建立之前完成的出片：孙经父继承得到。"""
    grand_after_parent: GenerationJob
    """祖父名下、父建立之后才完成的出片：父与孙都继承不到。"""
    from_parent: GenerationJob
    """父名下、孙建立之前完成的出片：孙继承得到。"""
    in_flight: GenerationJob
    """父名下、孙建立时还在跑、之后才完成的出片（已是完成态）：孙继承不到。"""
    parent_edit: GenerationJob
    """父名下、孙建立之前完成的编辑段，基底是 ``from_parent``：孙继承得到，但它不是成片。"""
    failed: GenerationJob
    """父名下失败的出片。"""
    parent_after_child: GenerationJob
    """父名下、孙建立之后完成的出片：孙继承不到。"""
    own: GenerationJob
    """孙自己的出片。"""


async def three_level_fork(engine: AsyncEngine) -> ForkChain:
    """落一条三层分叉链：每跳的边界各不相同，分叉时在途、失败、编辑段各一条。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    grand = await open_conversation(conversations, author)
    from_grand = await finished(repo, author, grand.id, "grand-early")
    parent = await open_conversation(conversations, author, forked_from=grand.id)
    grand_after_parent = await finished(repo, author, grand.id, "grand-after-parent")
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
    in_flight = await complete(repo, in_flight, "https://example.test/in-flight.mp4")
    parent_after_child = await finished(repo, author, parent.id, "parent-after-child")
    own = await finished(repo, forker, child.id, "child-own")
    return ForkChain(
        author=author,
        forker=forker,
        grand=grand,
        parent=parent,
        child=child,
        from_grand=from_grand,
        grand_after_parent=grand_after_parent,
        from_parent=from_parent,
        in_flight=in_flight,
        parent_edit=parent_edit,
        failed=failed,
        parent_after_child=parent_after_child,
        own=own,
    )


__all__ = [
    "ForkChain",
    "complete",
    "finished",
    "make_user",
    "open_conversation",
    "three_level_fork",
]
