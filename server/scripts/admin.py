"""引导型管理 CLI：直连数据库，绕过 API 层。

第一个 admin 只能从这里产生（密码注册默认 viewer、SSO 默认 editor，均无法自提权）。

用法：
    uv run --env-file ../.env python -m scripts.admin list-users
    uv run --env-file ../.env python -m scripts.admin set-role <username_or_email> admin
    uv run --env-file ../.env python -m scripts.admin issue-key <username_or_email> <key名> <perm1,perm2>
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from iclip.domains.identity.infra_sql import ApiKeyRow, User
from iclip.domains.identity.rbac import PERMISSIONS, ROLES
from iclip.domains.identity.service import (
    api_key_token_prefix,
    generate_api_key_token,
    hash_api_key_token,
)


def _database_url() -> str:
    url = os.environ.get("ICLIP_DATABASE_URL", "").strip()
    if not url:
        sys.exit("缺少环境变量 ICLIP_DATABASE_URL")
    return url


async def _find_user(session_factory: async_sessionmaker[AsyncSession], identifier: str) -> User:
    async with session_factory() as session:
        stmt = select(User).where((User.username == identifier) | (User.email == identifier))
        user = (await session.execute(stmt)).unique().scalar_one_or_none()
        if user is None:
            sys.exit(f"用户不存在: {identifier}")
        return user


async def _list_users() -> None:
    engine = create_async_engine(_database_url())
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions() as session:
            rows = (
                (await session.execute(select(User).order_by(User.created_at)))
                .unique()
                .scalars()
                .all()
            )
            for row in rows:
                flags = "" if row.is_active else " [停用]"
                print(f"{row.id}  {row.username or '-':<20} {row.email:<32} {row.role}{flags}")
    finally:
        await engine.dispose()


async def _set_role(identifier: str, role: str) -> None:
    if role not in ROLES:
        sys.exit(f"未知角色: {role}（可选: {', '.join(ROLES)}）")
    engine = create_async_engine(_database_url())
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        user = await _find_user(sessions, identifier)
        async with sessions() as session, session.begin():
            row = await session.get(User, user.id)
            assert row is not None
            row.role = role
        print(f"已把 {identifier} 的角色设为 {role}")
    finally:
        await engine.dispose()


async def _issue_key(identifier: str, name: str, permissions_csv: str) -> None:
    permissions = {p.strip() for p in permissions_csv.split(",") if p.strip()}
    unknown = permissions - set(PERMISSIONS)
    if not permissions or unknown:
        sys.exit(f"权限列表非法（未知: {', '.join(sorted(unknown)) or '空'}）")
    engine = create_async_engine(_database_url())
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        user = await _find_user(sessions, identifier)
        token = generate_api_key_token()
        async with sessions() as session, session.begin():
            session.add(
                ApiKeyRow(
                    id=uuid.uuid4(),
                    owner_user_id=user.id,
                    name=name,
                    token_hash=hash_api_key_token(token),
                    token_prefix=api_key_token_prefix(token),
                    permissions=sorted(permissions),
                    created_at=datetime.now(UTC),
                )
            )
        print("API key（明文仅此一次，请立即保存）：")
        print(token)
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="iClip 引导型管理 CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-users")
    p_role = sub.add_parser("set-role")
    p_role.add_argument("identifier")
    p_role.add_argument("role")
    p_key = sub.add_parser("issue-key")
    p_key.add_argument("identifier")
    p_key.add_argument("name")
    p_key.add_argument("permissions", help="逗号分隔权限列表")
    args = parser.parse_args()

    if args.command == "list-users":
        asyncio.run(_list_users())
    elif args.command == "set-role":
        asyncio.run(_set_role(args.identifier, args.role))
    else:
        asyncio.run(_issue_key(args.identifier, args.name, args.permissions))


if __name__ == "__main__":
    main()
