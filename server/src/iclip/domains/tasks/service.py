"""需求单状态流转与写入权限。

草稿仅创建者或治理者可改删；发布后冻结创作输入，补充字段见 schemas.PLANNER_FIELDS。
所有具备 tasks:write 的主体可认领或撤回。状态冲突返回 409，权限不足返回 403。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from iclip.common.errors import Conflict, PermissionDenied, ValidationFailed
from iclip.domains.identity.public import Principal
from iclip.domains.tasks.models import (
    STATUS_CONFIRMED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    STATUS_WITHDRAWN,
    Task,
    TaskStatus,
)
from iclip.domains.tasks.ports import StyleSnapshots
from iclip.domains.tasks.repository import TaskRepository
from iclip.domains.tasks.schemas import (
    MAX_LIST_LIMIT,
    PLANNER_FIELDS,
    TaskBrief,
    TaskCreateIn,
    TaskIn,
)

MANAGE_PERMISSION = "users:manage"

_CONFLICT_RACED = "这张需求单刚被别人改过，请重新读一次再试"


class TaskService:
    def __init__(self, repo: TaskRepository, snapshots: StyleSnapshots) -> None:
        self._repo = repo
        self._snapshots = snapshots

    async def create(self, principal: Principal, body: TaskCreateIn) -> Task:
        """创建草稿并冻结款号快照；快照获取失败时不创建需求单。"""

        style = await self._snapshots.of(body.style_no)
        now = datetime.now(UTC)
        return await self._repo.create(
            Task(
                id=uuid.uuid4(),
                title=body.title,
                status=STATUS_DRAFT,
                priority=body.priority,
                deadline=body.deadline,
                creator_user_id=principal.user_id,
                style=style,
                brief=body.brief.model_copy(
                    update={"style_nos": _style_nos_for(body.style_no, body.brief)}
                ),
                # 仓储使用数据库 now() 覆盖时间占位值。
                created_at=now,
                updated_at=now,
            )
        )

    async def get(self, task_id: uuid.UUID) -> Task:
        return await self._repo.get(task_id)

    async def list_recent(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        limit: int = 20,
    ) -> tuple[Task, ...]:
        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")
        return await self._repo.list_recent(
            status=status, assignee_user_id=assignee_user_id, limit=limit
        )

    async def update(self, principal: Principal, task_id: uuid.UUID, body: TaskIn) -> Task:
        """整体覆盖可变字段；发布后提交内容若改变冻结字段则拒绝。"""

        task = await self._repo.get(task_id)
        if task.status == STATUS_WITHDRAWN:
            raise Conflict("已撤回的需求单改不动了")
        if task.status == STATUS_DRAFT:
            _require_creator_or_manager(principal, task, action="修改这张草稿")
        else:
            _require_frozen_input_unchanged(task.brief, body.brief)
            if body.deadline is None:
                raise ValidationFailed("已下发的需求单必须有期限")

        saved = await self._repo.save(
            task_id,
            expect=task.status,
            title=body.title,
            priority=body.priority,
            deadline=body.deadline,
            # 整体覆盖仍须保留冻结的主款号。
            brief=body.brief.model_copy(
                update={"style_nos": _style_nos_for(task.style.style_no, body.brief)}
            ),
        )
        if saved is None:
            raise Conflict(_CONFLICT_RACED)
        return saved

    async def publish(self, principal: Principal, task_id: uuid.UUID) -> Task:
        """发布草稿并冻结创作输入。"""

        task = await self._repo.get(task_id)
        _require_status(task, STATUS_DRAFT, action="发布")
        _require_creator_or_manager(principal, task, action="发布这张需求单")
        if task.deadline is None:
            raise ValidationFailed("发布前必须定下期限")
        if not _says_what_to_make(task.brief):
            raise ValidationFailed("发布前至少要说清做什么：需求描述、主题或参考素材填一项")

        published = await self._repo.publish(task_id)
        if published is None:
            # 期限已过或状态已并发改变，调用方须重新读取。
            raise Conflict(f"发布失败：期限必须晚于当前时间，或{_CONFLICT_RACED}")
        return published

    async def confirm(self, principal: Principal, task_id: uuid.UUID) -> Task:
        """幂等认领需求单，支持多人认领；撤回后保留认领记录。"""

        task = await self._repo.get(task_id)
        if task.status not in (STATUS_PUBLISHED, STATUS_CONFIRMED):
            raise Conflict(f"只有已下发或已确认的需求单能认领，这张是 {task.status}")
        confirmed = await self._repo.confirm(task_id, user_id=principal.user_id)
        if confirmed is None:
            raise Conflict(_CONFLICT_RACED)
        return confirmed

    async def withdraw(self, task_id: uuid.UUID) -> Task:
        """将 published 或 confirmed 转为 withdrawn 终态。"""

        task = await self._repo.get(task_id)
        if task.status not in (STATUS_PUBLISHED, STATUS_CONFIRMED):
            raise Conflict(f"只有已下发或已确认的需求单能撤回，这张是 {task.status}")
        withdrawn = await self._repo.set_status(
            task_id, expect=task.status, status=STATUS_WITHDRAWN
        )
        if withdrawn is None:
            raise Conflict(_CONFLICT_RACED)
        return withdrawn

    async def delete(self, principal: Principal, task_id: uuid.UUID) -> None:
        """仅允许删除草稿；发布后的需求单通过撤回保留记录。"""

        task = await self._repo.get(task_id)
        _require_status(task, STATUS_DRAFT, action="删除")
        _require_creator_or_manager(principal, task, action="删除这张草稿")
        if not await self._repo.delete(task_id, expect=STATUS_DRAFT):
            raise Conflict(_CONFLICT_RACED)


def _style_nos_for(style_no: str, brief: TaskBrief) -> list[str]:
    """确保款号列表首项与冻结快照中的主款一致。"""

    if not brief.style_nos:
        return [style_no]
    if brief.style_nos[0] != style_no:
        raise ValidationFailed(f"brief.styleNos 的首位必须是主款号 {style_no}")
    return list(brief.style_nos)


def _require_status(task: Task, expected: TaskStatus, *, action: str) -> None:
    if task.status != expected:
        raise Conflict(f"只有 {expected} 状态的需求单能{action}，这张是 {task.status}")


def _require_creator_or_manager(principal: Principal, task: Task, *, action: str) -> None:
    """限制草稿写入为创建者或治理者；资源可见但不可写时返回 403。"""

    if principal.user_id == task.creator_user_id or principal.has(MANAGE_PERMISSION):
        return
    raise PermissionDenied(f"只有提出需求的人能{action}")


def _require_frozen_input_unchanged(stored: TaskBrief, incoming: TaskBrief) -> None:
    changed = [
        name
        for name in type(stored).model_fields
        if name not in PLANNER_FIELDS and getattr(stored, name) != getattr(incoming, name)
    ]
    if changed:
        raise Conflict(f"需求单已下发，这些创作输入不能再改：{'、'.join(changed)}")


def _says_what_to_make(brief: TaskBrief) -> bool:

    return bool(
        brief.requirement_description
        or brief.theme
        or brief.reference_images
        or brief.reference_videos
    )


__all__ = ["MANAGE_PERMISSION", "TaskService"]
