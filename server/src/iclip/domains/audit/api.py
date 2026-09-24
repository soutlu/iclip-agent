"""审计报表 HTTP 端点。三个只读口都要 ``users:manage``，形状见合同 §12。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from iclip.domains.audit.models import DEFAULT_THRESHOLDS, AnomalyKind, Bucket, Thresholds
from iclip.domains.audit.schemas import AnomaliesOut, AuditConversationsOut, SummaryOut
from iclip.domains.audit.service import AuditService
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, require_permission
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT

UserNameQuery = Annotated[str | None, Query(alias="userName", max_length=150)]
TaskIdQuery = Annotated[uuid.UUID | None, Query(alias="taskId")]


def create_audit_router(service: AuditService) -> APIRouter:
    router = APIRouter(prefix="/audit", tags=["audit"])

    @router.get("/summary", response_model=SummaryOut)
    async def summary(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: UserNameQuery = None,
        task_id: TaskIdQuery = None,
        bucket: Bucket | None = None,
        timezone: Annotated[str, Query(max_length=64)] = "UTC",
    ) -> SummaryOut:
        """全体一格、每人一行、每单一行；给 ``bucket`` 再多一条按 ``timezone`` 切的时段序列。

        各指标的定义、时间窗落在哪个时刻上、``attemptDistribution`` 只给全体一档，见合同 §12。
        """

        return await service.summary(
            since=since,
            until=until,
            user_name=user_name,
            task_id=task_id,
            bucket=bucket,
            timezone=timezone,
        )

    @router.get("/conversations", response_model=AuditConversationsOut)
    async def conversations(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: UserNameQuery = None,
        task_id: TaskIdQuery = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> AuditConversationsOut:
        """有成片的对话，最后成片晚的排前面；每行的指标、镜明细与按模型用量都是这段对话的全量。

        时间窗与翻页规则见合同 §12。
        """

        return await service.conversations(
            since=since,
            until=until,
            user_name=user_name,
            task_id=task_id,
            limit=limit,
            cursor=cursor,
        )

    @router.get("/anomalies", response_model=AnomaliesOut)
    async def anomalies(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: UserNameQuery = None,
        task_id: TaskIdQuery = None,
        kind: Annotated[list[AnomalyKind] | None, Query()] = None,
        retry_over: Annotated[int, Query(alias="retryOver", ge=1)] = DEFAULT_THRESHOLDS.retry_over,
        idle_hours: Annotated[int, Query(alias="idleHours", ge=1)] = DEFAULT_THRESHOLDS.idle_hours,
        stuck_hours: Annotated[
            int, Query(alias="stuckHours", ge=1)
        ] = DEFAULT_THRESHOLDS.stuck_hours,
        task_conversations: Annotated[
            int, Query(alias="taskConversations", ge=1)
        ] = DEFAULT_THRESHOLDS.task_conversations,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> AnomaliesOut:
        """异常按发生时刻倒序。``kind`` 可重复给，不给就全部种类。

        九种异常的判定、阈值参数管哪几种、``slow`` 与 ``spend`` 的门槛按筛选范围现算，见合同 §12。
        """

        return await service.anomalies(
            since=since,
            until=until,
            user_name=user_name,
            task_id=task_id,
            kinds=kind,
            thresholds=Thresholds(
                retry_over=retry_over,
                idle_hours=idle_hours,
                stuck_hours=stuck_hours,
                task_conversations=task_conversations,
            ),
            limit=limit,
            cursor=cursor,
        )

    return router


__all__ = ["create_audit_router"]
