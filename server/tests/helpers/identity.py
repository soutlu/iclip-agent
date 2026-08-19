"""identity 测试替身与构造器。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from iclip.domains.identity.models import ApiKeyRecord, PmsDepartment, UserAccount


def make_account(
    *,
    user_id: uuid.UUID | None = None,
    role: str = "editor",
    is_active: bool = True,
    username: str | None = "luke",
    email: str = "luke@example.com",
) -> UserAccount:
    return UserAccount(
        id=user_id or uuid.uuid4(),
        email=email,
        username=username,
        display_name="Luke",
        avatar_url="",
        role=role,
        is_active=is_active,
        city="",
        job_title="",
        departments=(),
        created_at=datetime.now(UTC),
        last_login_at=None,
    )


def make_department(name: str = "市场部") -> PmsDepartment:
    return PmsDepartment(
        id=1,
        uid="d-1",
        name=name,
        parent_id=None,
        parent_uid="",
        leader_user_id=None,
        leader_user_uid="",
        source="pms",
        type="dept",
        order=1,
    )


class InMemoryUserRepository:
    def __init__(self, accounts: list[UserAccount] | None = None) -> None:
        self.accounts: dict[uuid.UUID, UserAccount] = {
            account.id: account for account in accounts or []
        }

    async def get(self, user_id: uuid.UUID) -> UserAccount | None:
        return self.accounts.get(user_id)

    async def list_page(self, *, offset: int, limit: int) -> tuple[tuple[UserAccount, ...], int]:
        ordered = sorted(self.accounts.values(), key=lambda a: a.created_at or datetime.now(UTC))
        return tuple(ordered[offset : offset + limit]), len(ordered)

    async def update_admin_fields(
        self, user_id: uuid.UUID, *, role: str | None, is_active: bool | None
    ) -> UserAccount | None:
        account = self.accounts.get(user_id)
        if account is None:
            return None
        from dataclasses import replace

        if role is not None:
            account = replace(account, role=role)
        if is_active is not None:
            account = replace(account, is_active=is_active)
        self.accounts[user_id] = account
        return account

    async def touch_last_login(self, user_id: uuid.UUID, at: datetime) -> None:
        pass

    async def sync_sso_profile(self, user_id: uuid.UUID, **_: object) -> None:
        pass


class InMemoryApiKeyRepository:
    def __init__(self) -> None:
        self.records: dict[uuid.UUID, ApiKeyRecord] = {}
        self.hashes: dict[str, uuid.UUID] = {}

    async def add(self, record: ApiKeyRecord, *, token_hash: str) -> None:
        from dataclasses import replace

        stored = replace(record, created_at=datetime.now(UTC))
        self.records[record.id] = stored
        self.hashes[token_hash] = record.id

    async def get(self, key_id: uuid.UUID) -> ApiKeyRecord | None:
        return self.records.get(key_id)

    async def get_by_hash(self, token_hash: str) -> ApiKeyRecord | None:
        key_id = self.hashes.get(token_hash)
        return self.records.get(key_id) if key_id else None

    async def list_for_owner(self, owner: uuid.UUID | None) -> tuple[ApiKeyRecord, ...]:
        records = self.records.values()
        if owner is not None:
            records = [r for r in records if r.owner_user_id == owner]
        return tuple(records)

    async def revoke(self, key_id: uuid.UUID, at: datetime) -> None:
        from dataclasses import replace

        record = self.records.get(key_id)
        if record is not None and record.revoked_at is None:
            self.records[key_id] = replace(record, revoked_at=at)

    async def touch_last_used(self, key_id: uuid.UUID, at: datetime) -> None:
        from dataclasses import replace

        record = self.records.get(key_id)
        if record is not None:
            self.records[key_id] = replace(record, last_used_at=at)
