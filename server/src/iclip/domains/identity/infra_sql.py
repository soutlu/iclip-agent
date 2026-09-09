"""identity SQL 适配器：ORM 表（fastapi-users 要求 declarative）+ 仓储实现。

schema 固定为 ``iclip``（declarative 类定义期无法按配置动态化；
config 的 db_schema 必须与此一致，组合根启动期校验）。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi_users_db_sqlalchemy import (
    SQLAlchemyBaseOAuthAccountTableUUID,
    SQLAlchemyBaseUserTableUUID,
)
from fastapi_users_db_sqlalchemy.generics import GUID
from sqlalchemy import DateTime, ForeignKey, MetaData, String, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column, relationship

from iclip.domains.identity.models import ApiKeyRecord, PmsDepartment, UserAccount
from iclip.platform.db.ownership import scope_to_owner

DB_SCHEMA = "iclip"

SessionFactory = async_sessionmaker[AsyncSession]


class Base(DeclarativeBase):
    metadata = MetaData(schema=DB_SCHEMA)


class User(SQLAlchemyBaseUserTableUUID, Base):
    __tablename__ = "users"

    username: Mapped[str | None] = mapped_column(String(150), unique=True, nullable=True)
    display_name: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    avatar_url: Mapped[str] = mapped_column(String(1024), default="", nullable=False)
    # 密码注册的默认身份；SSO 首登在 sync 中覆写为 ["editor"]。
    roles: Mapped[list[str]] = mapped_column(JSONB, default=lambda: ["viewer"], nullable=False)
    direct_permissions: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    city: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    job_title: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    departments: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    oauth_accounts: Mapped[list[OAuthAccount]] = relationship(lazy="joined")


class OAuthAccount(SQLAlchemyBaseOAuthAccountTableUUID, Base):
    __tablename__ = "oauth_accounts"

    @declared_attr
    def user_id(cls) -> Mapped[uuid.UUID]:  # pyright: ignore[reportIncompatibleVariableOverride]
        # 基类的 FK 目标不带 schema，跨 schema 元数据解析不到，必须覆写。
        return mapped_column(
            GUID,
            ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="cascade"),
            nullable=False,
            index=True,
        )


class ApiKeyRow(Base):
    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        GUID,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="cascade"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    token_prefix: Mapped[str] = mapped_column(String(24), nullable=False)
    permissions: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


def department_to_json(dept: PmsDepartment) -> dict[str, Any]:
    return {
        "id": dept.id,
        "uid": dept.uid,
        "name": dept.name,
        "parentId": dept.parent_id,
        "parentUid": dept.parent_uid,
        "leaderUserId": dept.leader_user_id,
        "leaderUserUid": dept.leader_user_uid,
        "source": dept.source,
        "type": dept.type,
        "order": dept.order,
    }


def _department_from_json(data: dict[str, Any]) -> PmsDepartment:
    return PmsDepartment(
        id=int(data["id"]),
        uid=str(data.get("uid") or ""),
        name=str(data.get("name") or ""),
        parent_id=data.get("parentId"),
        parent_uid=str(data.get("parentUid") or ""),
        leader_user_id=data.get("leaderUserId"),
        leader_user_uid=str(data.get("leaderUserUid") or ""),
        source=str(data.get("source") or ""),
        type=str(data.get("type") or ""),
        order=data.get("order"),
    )


def account_from_row(row: User) -> UserAccount:
    """将 ORM 行转换为领域快照；持久化部门 JSON 非法时抛出校验错误。"""

    return UserAccount(
        id=row.id,
        email=row.email,
        username=row.username,
        display_name=row.display_name,
        avatar_url=row.avatar_url,
        roles=tuple(row.roles),
        direct_permissions=frozenset(row.direct_permissions),
        is_active=row.is_active,
        city=row.city,
        job_title=row.job_title,
        departments=tuple(_department_from_json(item) for item in row.departments),
        created_at=row.created_at,
        last_login_at=row.last_login_at,
    )


def _record_from_row(row: ApiKeyRow) -> ApiKeyRecord:
    return ApiKeyRecord(
        id=row.id,
        owner_user_id=row.owner_user_id,
        name=row.name,
        token_prefix=row.token_prefix,
        permissions=frozenset(row.permissions),
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        last_used_at=row.last_used_at,
        created_at=row.created_at,
    )


class SqlUserRepository:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions

    async def get(self, user_id: uuid.UUID) -> UserAccount | None:
        async with self._sessions() as session:
            row = await session.get(User, user_id)
            return account_from_row(row) if row is not None else None

    async def list_page(self, *, offset: int, limit: int) -> tuple[tuple[UserAccount, ...], int]:
        async with self._sessions() as session:
            total = (await session.execute(select(func.count()).select_from(User))).scalar_one()
            rows = (
                (
                    await session.execute(
                        select(User)
                        .order_by(
                            User.created_at.desc(),
                            User.id,  # pyright: ignore[reportArgumentType]
                        )
                        .offset(offset)
                        .limit(limit)
                    )
                )
                .unique()
                .scalars()
                .all()
            )
            return tuple(account_from_row(row) for row in rows), int(total)

    async def update_access_fields(
        self,
        user_id: uuid.UUID,
        *,
        roles: tuple[str, ...] | None,
        direct_permissions: frozenset[str] | None,
        is_active: bool | None,
    ) -> UserAccount | None:
        async with self._sessions() as session, session.begin():
            row = await session.get(User, user_id)
            if row is None:
                return None
            if roles is not None:
                row.roles = list(roles)
            if direct_permissions is not None:
                row.direct_permissions = sorted(direct_permissions)
            if is_active is not None:
                row.is_active = is_active
            await session.flush()
            return account_from_row(row)

    async def ensure_role(self, user_id: uuid.UUID, role: str) -> None:
        async with self._sessions() as session, session.begin():
            row = await session.get(User, user_id)
            if row is not None and role not in row.roles:
                row.roles = [*row.roles, role]

    async def touch_last_login(self, user_id: uuid.UUID, at: datetime) -> None:
        async with self._sessions() as session, session.begin():
            row = await session.get(User, user_id)
            if row is not None:
                row.last_login_at = at

    async def sync_sso_profile(
        self,
        user_id: uuid.UUID,
        *,
        display_name: str,
        avatar_url: str,
        roles: tuple[str, ...] | None,
        city: str | None,
        job_title: str | None,
        departments: tuple[PmsDepartment, ...] | None,
    ) -> None:
        async with self._sessions() as session, session.begin():
            row = await session.get(User, user_id)
            if row is None:
                return
            if display_name:
                row.display_name = display_name
            if avatar_url:
                row.avatar_url = avatar_url
            if roles is not None:
                row.roles = list(roles)
            if city is not None:
                row.city = city
            if job_title is not None:
                row.job_title = job_title
            if departments is not None:
                row.departments = [department_to_json(d) for d in departments]


class SqlApiKeyRepository:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions

    async def add(self, record: ApiKeyRecord, *, token_hash: str) -> None:
        async with self._sessions() as session, session.begin():
            session.add(
                ApiKeyRow(
                    id=record.id,
                    owner_user_id=record.owner_user_id,
                    name=record.name,
                    token_hash=token_hash,
                    token_prefix=record.token_prefix,
                    permissions=sorted(record.permissions),
                    expires_at=record.expires_at,
                )
            )

    async def get(self, key_id: uuid.UUID) -> ApiKeyRecord | None:
        async with self._sessions() as session:
            row = await session.get(ApiKeyRow, key_id)
            return _record_from_row(row) if row is not None else None

    async def get_by_hash(self, token_hash: str) -> ApiKeyRecord | None:
        async with self._sessions() as session:
            row = (
                await session.execute(select(ApiKeyRow).where(ApiKeyRow.token_hash == token_hash))
            ).scalar_one_or_none()
            return _record_from_row(row) if row is not None else None

    async def list_for_owner(self, owner: uuid.UUID | None) -> tuple[ApiKeyRecord, ...]:
        async with self._sessions() as session:
            stmt = select(ApiKeyRow).order_by(ApiKeyRow.created_at.desc(), ApiKeyRow.id)
            stmt = scope_to_owner(stmt, ApiKeyRow.owner_user_id, owner)
            rows = (await session.execute(stmt)).scalars().all()
            return tuple(_record_from_row(row) for row in rows)

    async def revoke(self, key_id: uuid.UUID, at: datetime) -> None:
        async with self._sessions() as session, session.begin():
            row = await session.get(ApiKeyRow, key_id)
            if row is not None and row.revoked_at is None:
                row.revoked_at = at

    async def touch_last_used(self, key_id: uuid.UUID, at: datetime) -> None:
        async with self._sessions() as session, session.begin():
            row = await session.get(ApiKeyRow, key_id)
            if row is not None:
                row.last_used_at = at


async def get_user_row_by_username(session: AsyncSession, username: str) -> User | None:
    """按 username 查用户行（fastapi-users 适配层的登录标识解析用）。"""

    result = await session.execute(select(User).where(User.username == username))
    return result.unique().scalar_one_or_none()


__all__ = [
    "DB_SCHEMA",
    "ApiKeyRow",
    "Base",
    "OAuthAccount",
    "SqlApiKeyRepository",
    "SqlUserRepository",
    "User",
    "account_from_row",
    "department_to_json",
    "get_user_row_by_username",
]
