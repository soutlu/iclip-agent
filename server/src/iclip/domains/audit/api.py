"""审计报表 HTTP 端点。三个只读口都要 ``users:manage``，形状见合同 §12。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from iclip.domains.audit.models import AnomalyKind, Bucket, Thresholds
from iclip.domains.audit.schemas import (
    AnomaliesOut,
    AuditConversationsOut,
    SummaryOut,
    anomaly_out,
    conversation_out,
    metrics_out,
    period_metrics_out,
    task_metrics_out,
    user_metrics_out,
)
from iclip.domains.audit.service import AuditService
from iclip.domains.identity.public import Principal, require_authenticated

UserNameQuery = Annotated[str | None, Query(alias="userName", max_length=150)]
TaskIdQuery = Annotated[uuid.UUID | None, Query(alias="taskId")]


def create_audit_router(service: AuditService) -> APIRouter:
    router = APIRouter(prefix="/audit", tags=["audit"])

    @router.get("/summary", response_model=SummaryOut)
    async def summary(
        principal: Annotated[Principal, Depends(require_authenticated)],
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: UserNameQuery = None,
        task_id: TaskIdQuery = None,
        bucket: Bucket | None = None,
        timezone: Annotated[str, Query(max_length=64)] = "UTC",
    ) -> SummaryOut:
        """全体一格、每人一行、每单一行；给 ``bucket`` 再多一条按 ``timezone`` 切的时段序列。

        ``since`` / ``until`` 作用在各指标自己的锚点上：成片与视频耗时看完成时刻，每镜次数看
        该镜首次出片时刻，交付周期看最后成片时刻，模型用量整段对话按最后记账时刻归期。
        """

        found = await service.summary(
            principal,
            since=since,
            until=until,
            user_name=user_name,
            task_id=task_id,
            bucket=bucket,
            timezone=timezone,
        )
        return SummaryOut(
            overall=metrics_out(found.overall),
            users=[user_metrics_out(item) for item in found.users],
            tasks=[task_metrics_out(item) for item in found.tasks],
            series=None
            if found.series is None
            else [period_metrics_out(item) for item in found.series],
        )

    @router.get("/conversations", response_model=AuditConversationsOut)
    async def conversations(
        principal: Annotated[Principal, Depends(require_authenticated)],
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: UserNameQuery = None,
        task_id: TaskIdQuery = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        cursor: str | None = None,
    ) -> AuditConversationsOut:
        """有成片的对话，最后成片晚的排前面；时间窗作用在最后成片时刻上。

        每行的指标、镜明细与按模型用量都是这段对话的全量。属主删掉的对话照列，``deletedAt`` 非空。
        """

        page = await service.conversations(
            principal,
            since=since,
            until=until,
            user_name=user_name,
            task_id=task_id,
            limit=limit,
            cursor=cursor,
        )
        return AuditConversationsOut(
            items=[conversation_out(item) for item in page.items], next_cursor=page.next_cursor
        )

    @router.get("/anomalies", response_model=AnomaliesOut)
    async def anomalies(
        principal: Annotated[Principal, Depends(require_authenticated)],
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: UserNameQuery = None,
        task_id: TaskIdQuery = None,
        kind: Annotated[list[AnomalyKind] | None, Query()] = None,
        retry_over: Annotated[int, Query(alias="retryOver", ge=1)] = 2,
        idle_hours: Annotated[int, Query(alias="idleHours", ge=1)] = 24,
        stuck_hours: Annotated[int, Query(alias="stuckHours", ge=1)] = 1,
        task_conversations: Annotated[int, Query(alias="taskConversations", ge=1)] = 3,
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        cursor: str | None = None,
    ) -> AnomaliesOut:
        """异常按发生时刻倒序。``kind`` 可重复给，不给就全部种类。

        阈值参数只管数得出来的那几种；``slow`` 与 ``spend`` 的门槛按当前筛选范围现算 P90 / P95，
        范围小时门槛会抖。
        """

        page = await service.anomalies(
            principal,
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
        return AnomaliesOut(
            items=[anomaly_out(item) for item in page.items], next_cursor=page.next_cursor
        )

    return router


__all__ = ["create_audit_router"]
