"""创作需求单的用例层：谁能改、什么时候能改、能改哪几项。

三条规则撑起这个模块，其余都是它们的推论：

1. **需求单人人可见。** 它是全公司的工作队列，``tasks:read`` 就够。所以这里没有
   「不可见」这种情况——判断只在「能不能改」这一侧，看得见但不让改就是 403
   （不变量 9）。
2. **下发即冻结。** 一旦 ``published``，需求方写下的创作输入就不许再动；能改的只剩
   管理信息和接单之后才补得出来的那几项（见 ``schemas.PLANNER_FIELDS``）。接单的人
   是照着那份需求开工的，改了等于让两边看到的需求不一样。
3. **草稿是私事，流转是公事。** 草稿只有提它的人（或治理者）能改能删；下发之后的
   接单、撤回、补充，任何有 ``tasks:write`` 的人都能做——那正是协作发生的地方。

状态走不通一律抛 ``Conflict``（409），不是 ``ValidationFailed``：跨端合同把 409 的
释义定成「请求与资源当前状态冲突」，撤回一张已确认的需求单就是它举的例子。
"""

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
    """建需求单、读需求单、改它、把它推过状态机。"""

    def __init__(self, repo: TaskRepository, snapshots: StyleSnapshots) -> None:
        self._repo = repo
        self._snapshots = snapshots

    async def list_project_ids(self, task_id: uuid.UUID) -> tuple[uuid.UUID, ...]:
        """这张单算在哪几个项目里。先确认单在（不在就 404）。"""

        await self._repo.get(task_id)
        return await self._repo.list_project_ids(task_id)

    async def set_project_ids(
        self, task_id: uuid.UUID, *, project_ids: tuple[uuid.UUID, ...]
    ) -> tuple[uuid.UUID, ...]:
        """整体覆盖这张单挂的项目（给空的就是全部取消）。

        公事，持 ``tasks:write`` 就能做，所以不挑人——归类这摊活跟谁提的需求无关。
        不受「下发即冻结」约束：项目是管理信息，不是需求方写下的创作输入。
        """

        await self._repo.get(task_id)
        return await self._repo.set_project_ids(task_id, project_ids=project_ids)

    async def create(self, principal: Principal, body: TaskCreateIn) -> Task:
        """提一张新需求单。落地就是草稿，发布是另一个动作。

        款号先抄成快照冻结进这一行，抄不到就整体失败：说不清拍哪个款的单子不如不落地。
        """

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
                # 两个时刻在插入时由数据库改写成它自己的 now()；这里的值不落库，
                # 只是把 dataclass 填满。
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
        """整体覆盖一张需求单。

        覆盖是整体的，但**允许覆盖的范围随状态收窄**：草稿随便改，下发之后只剩管理信
        息与那几项补充字段。所以这里拿提交上来的 brief 和库里的逐字段比一遍，冻结的
        那些只要有一项不一样就拒——而不是默默地把它们改回去。
        """

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
            # 主款号跟着快照走，覆盖不掉：PUT 是整体覆盖，不对齐一次的话不给 styleNos
            # 就把它清空了，给错首位就和快照说的不是同一个款。
            brief=body.brief.model_copy(
                update={"style_nos": _style_nos_for(task.style.style_no, body.brief)}
            ),
        )
        if saved is None:
            raise Conflict(_CONFLICT_RACED)
        return saved

    async def publish(self, principal: Principal, task_id: uuid.UUID) -> Task:
        """``draft`` → ``published``：把需求下发出去，创作输入就此冻结。"""

        task = await self._repo.get(task_id)
        _require_status(task, STATUS_DRAFT, action="发布")
        _require_creator_or_manager(principal, task, action="发布这张需求单")
        if task.deadline is None:
            raise ValidationFailed("发布前必须定下期限")
        if not _says_what_to_make(task.brief):
            raise ValidationFailed("发布前至少要说清做什么：需求描述、主题或参考素材填一项")

        published = await self._repo.publish(task_id)
        if published is None:
            # 走到这里，要么期限在刚才那一瞬已经过去，要么别人抢先改了状态。两种都
            # 是「拿着过期的认知在写」，让人重读一次再决定。
            raise Conflict(f"发布失败：期限必须晚于当前时间，或{_CONFLICT_RACED}")
        return published

    async def confirm(self, principal: Principal, task_id: uuid.UUID) -> Task:
        """认领这张需求单：``published`` → ``confirmed``，并记下是谁认领的。

        认领不挑人：任何有 ``tasks:write`` 的人都能认领，也不限量——一张单可以被多
        个人认领（追加进 ``task_assignees``），已经 ``confirmed`` 的单再认领只是多
        一个人加入。谁认领的、什么时候认领的都落在那张关联表上，撤回也不抹掉。
        """

        task = await self._repo.get(task_id)
        if task.status not in (STATUS_PUBLISHED, STATUS_CONFIRMED):
            raise Conflict(f"只有已下发或已确认的需求单能认领，这张是 {task.status}")
        confirmed = await self._repo.confirm(task_id, user_id=principal.user_id)
        if confirmed is None:
            raise Conflict(_CONFLICT_RACED)
        return confirmed

    async def withdraw(self, task_id: uuid.UUID) -> Task:
        """``published`` / ``confirmed`` → ``withdrawn``：这张需求单不做了。

        撤回是终态，不提供「撤回之后再发布」——那是一张新的需求单。已经照着它开工的
        人需要看见「它被撤了」这件事，把它改回去等于抹掉这段历史。
        """

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
        """删掉一张草稿。

        下发之后就删不掉了：那时它已经是发生过的事实，别人可能正照着它干活。不想做了
        就撤回——撤回留痕，删除不留。
        """

        task = await self._repo.get(task_id)
        _require_status(task, STATUS_DRAFT, action="删除")
        _require_creator_or_manager(principal, task, action="删除这张草稿")
        if not await self._repo.delete(task_id, expect=STATUS_DRAFT):
            raise Conflict(_CONFLICT_RACED)


def _style_nos_for(style_no: str, brief: TaskBrief) -> list[str]:
    """对齐主款号与 brief 里的款号全集，返回该落库的那一份。

    不对齐的后果是静默的：封面显示的款和详情里列的款各说一套，没人会发现。
    """

    if not brief.style_nos:
        return [style_no]
    if brief.style_nos[0] != style_no:
        raise ValidationFailed(f"brief.styleNos 的首位必须是主款号 {style_no}")
    return list(brief.style_nos)


def _require_status(task: Task, expected: TaskStatus, *, action: str) -> None:
    if task.status != expected:
        raise Conflict(f"只有 {expected} 状态的需求单能{action}，这张是 {task.status}")


def _require_creator_or_manager(principal: Principal, task: Task, *, action: str) -> None:
    """草稿是提它的人的私事；治理者可以代劳。

    这里返 403 而不是 404：需求单本来就人人看得见，藏起来毫无意义（不变量 9 说的是
    「不可见的返 404」，而这张单子是可见的）。
    """

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
    """这份 brief 至少说清了要做什么吗？

    门槛只要求四项里有一项：一句需求描述、一个主题，或者一条参考素材。定得再高就会
    逼着需求方在草稿阶段把不知道的字段先编上，那比空着更糟。
    """

    return bool(
        brief.requirement_description
        or brief.theme
        or brief.reference_images
        or brief.reference_videos
    )


__all__ = ["MANAGE_PERMISSION", "TaskService"]
