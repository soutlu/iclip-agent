"""PMS 用户资料客户端。

只在 SSO callback 调用一次；普通产品请求不外呼。协议：
  GET {base}/pms-console/user/selectUserById/{innerUserId}
  Authorization: {SSO jwt}
  → {success: true, data: {city, jobTitle, depts: [...]}}
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

import httpx

from iclip.domains.identity.models import PmsDepartment

_USER_INFO_PATH = "/pms-console/user/selectUserById/{inner_user_id}"
_TIMEOUT_SECONDS = 5.0


class PmsUnavailable(Exception):
    """PMS 用户资料服务不可达或响应不符合约定（映射 502，终止本次 SSO callback）。"""


@dataclass(frozen=True, slots=True)
class PmsUserProfile:
    city: str
    job_title: str
    departments: tuple[PmsDepartment, ...]


class PmsUserClient:
    def __init__(
        self,
        *,
        base_url: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._transport = transport

    async def get_user(self, *, inner_user_id: int, authorization: str) -> PmsUserProfile:
        if inner_user_id <= 0:
            raise ValueError("inner_user_id 必须为正整数")
        if not authorization.strip():
            raise ValueError("authorization 不能为空")

        path = _USER_INFO_PATH.format(inner_user_id=quote(str(inner_user_id), safe=""))
        url = f"{self._base_url}{path}"
        try:
            async with httpx.AsyncClient(
                timeout=_TIMEOUT_SECONDS, transport=self._transport
            ) as client:
                response = await client.get(url, headers={"Authorization": authorization})
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise PmsUnavailable("PMS 用户资料服务不可用") from exc

        if not isinstance(payload, dict) or payload.get("success") is not True:
            description = (
                str(payload.get("responseDesc") or "").strip() if isinstance(payload, dict) else ""
            )
            raise PmsUnavailable(description or "PMS 用户资料响应失败")

        data = payload.get("data")
        if not isinstance(data, dict):
            raise PmsUnavailable("PMS 用户资料响应缺少 data")

        return PmsUserProfile(
            city=_string(data.get("city")),
            job_title=_string(data.get("jobTitle")),
            departments=_parse_departments(data.get("depts")),
        )


def _parse_departments(value: object) -> tuple[PmsDepartment, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise PmsUnavailable("PMS 用户资料 depts 格式无效")
    return tuple(
        PmsDepartment(
            id=_integer(item.get("id"), field="depts.id"),
            uid=_string(item.get("uid")),
            name=_string(item.get("name")),
            parent_id=_optional_integer(item.get("parentId"), field="depts.parentId"),
            parent_uid=_string(item.get("parentUid")),
            leader_user_id=_optional_integer(item.get("leaderUserId"), field="depts.leaderUserId"),
            leader_user_uid=_string(item.get("leaderUserUid")),
            source=_string(item.get("source")),
            type=_string(item.get("type")),
            order=_optional_integer(item.get("order"), field="depts.order"),
        )
        for item in value
    )


def _string(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _integer(value: object, *, field: str) -> int:
    parsed = _optional_integer(value, field=field)
    if parsed is None:
        raise PmsUnavailable(f"PMS 用户资料 {field} 格式无效")
    return parsed


def _optional_integer(value: object, *, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise PmsUnavailable(f"PMS 用户资料 {field} 格式无效")
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise PmsUnavailable(f"PMS 用户资料 {field} 格式无效") from exc


__all__ = ["PmsUnavailable", "PmsUserClient", "PmsUserProfile"]
