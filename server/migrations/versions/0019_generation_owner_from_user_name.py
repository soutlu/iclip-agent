"""iclip.generation_jobs：属主与请求里的 ``user_name`` 对不上的行，属主改成那个名字的账号。

Revision ID: 69f785644eb5
Revises: 3403faebf6dc
Create Date: 2026-09-25 21:00:00.000000

替人办事 2026-09-15 启用前，钥匙提交的行属主记的是钥匙主人，请求里的 ``user_name`` 才是真人；
钥匙对话里工具出的图也一样。现在作者一律取属主的用户名，所以把这些行的属主改成同名账号，没有
账号的照替人办事的规则建占位账号，本人日后 SSO 首登按用户名认领。

名字取 ``user_name``（出片、编辑段）或 ``userName``（图片、合成按别名落库）。名字为空（缺键、
JSON null、空串、全空白）的、等于属主用户名的行不动。所在对话是分叉副本的行也不动：副本里的
行由分叉的人做，名字是从源对话带来的对账标签，副本归分叉的人。

先核对，任何一条对不上就带 id 报错、整个迁移回滚：请求里两个键同时出现、名字放不进用户名列、
名字与已有账号或别的待建名字只差大小写、占位邮箱已被别的账号占用。改完再核一遍，仍有对不上的
就报错，不静默留下。只改 ``owner_user_id``：``request``、``api_key_id``、对话属主与运行记录都不动。

不可逆：降级不改回，建的占位账号也留着（本人可能已经认领）；降级后重升，不一致的行已经没有，空转。
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import Mapping, Sequence

import sqlalchemy as sa
from alembic import op
from fastapi_users.password import PasswordHelper

revision: str = "69f785644eb5"
down_revision: str | None = "3403faebf6dc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
JOBS = f"{SCHEMA}.generation_jobs"
USERS = f"{SCHEMA}.users"
CONVERSATIONS = f"{SCHEMA}.conversations"

_USERNAME_MAX_CHARS = 150
"""``users.username`` 的列宽 ``String(150)``；请求里的名字上限是 200，长出来的放不进去。"""

_PLACEHOLDER_NAMESPACE = uuid.UUID("8f0c6a1e-5b7d-4e2a-9c3f-1d4b6e8a0c2f")
_PLACEHOLDER_DOMAIN = "sso.iclip.example"
"""与 ``identity/acting.py`` 的 ``placeholder_email`` 同一规则，照搬成常量：迁移不 import 业务代码。
邮箱差一个字节 SSO 首登就认领不了；迁移测试 import 那个函数核对两边一致。"""

_NAME = "COALESCE(g.request->>'user_name', g.request->>'userName')"
"""两种键名一条式子覆盖；两个键同时出现的行先被核对拒掉。"""

_MISMATCHED = f"""
    SELECT g.id, {_NAME} AS name
    FROM {JOBS} g
    JOIN {USERS} o ON o.id = g.owner_user_id
    WHERE NULLIF(btrim({_NAME}), '') IS NOT NULL
      AND {_NAME} IS DISTINCT FROM o.username
      AND NOT EXISTS (
          SELECT 1 FROM {CONVERSATIONS} c
          WHERE c.id = g.conversation_id AND c.forked_from IS NOT NULL
      )
"""
"""要校正的行。属主没有用户名也算对不上，所以用 ``IS DISTINCT FROM`` 而不是 ``<>``；名字按原样
精确比较、区分大小写，与替人办事按用户名找账号一致。对话不存在的行不算副本，照样校正。"""

_FRESH = f"""
    SELECT m.id, m.name FROM ({_MISMATCHED}) m
    WHERE NOT EXISTS (SELECT 1 FROM {USERS} u WHERE u.username = m.name)
"""
"""要校正、但名字还没有账号的行：这些名字要建占位账号。"""


def upgrade() -> None:
    _check_names()
    accounts = _placeholder_accounts()
    if accounts:
        _require_empty(
            f"SELECT email FROM {USERS} WHERE email = ANY(CAST(:emails AS text[])) ORDER BY 1",
            "占位邮箱已被别的账号占用，先人工处理",
            {"emails": [account["email"] for account in accounts]},
        )
        op.get_bind().execute(
            sa.text(
                f"""
                INSERT INTO {USERS} (id, email, hashed_password, is_active, is_superuser,
                    is_verified, username, display_name, avatar_url, roles, direct_permissions,
                    city, job_title, departments)
                VALUES (:id, :email, :password, true, false, false, :name, :name, '',
                    '[]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)
                """
            ),
            accounts,
        )

    op.execute(
        f"""
        UPDATE {JOBS} AS t
        SET owner_user_id = n.id
        FROM ({_MISMATCHED}) AS m
        JOIN {USERS} AS n ON n.username = m.name
        WHERE t.id = m.id
        """
    )
    _require_empty(
        f"SELECT m.id FROM ({_MISMATCHED}) m ORDER BY 1", "校正后仍有属主与 user_name 对不上的行"
    )


def _check_names() -> None:
    """名字要能原样落进用户名列、唯一对上一个账号；有歧义的交人判断，不猜。

    只差大小写的名字有意比运行时严：替人办事按用户名精确找，找不到会另建一个只差大小写的
    占位账号。一次性回填有人盯着，报错比多出一个分身账号好修。
    """

    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE jsonb_exists(request, 'user_name') AND jsonb_exists(request, 'userName')
        ORDER BY 1
        """,
        "请求里同时带 user_name 与 userName，先人工处理",
    )
    _require_empty(
        f"""
        SELECT m.id FROM ({_MISMATCHED}) m
        WHERE length(m.name) > {_USERNAME_MAX_CHARS} OR m.name <> btrim(m.name)
        ORDER BY 1
        """,
        f"user_name 放不进用户名（超过 {_USERNAME_MAX_CHARS} 字或带首尾空白），先人工处理",
    )
    _require_empty(
        f"""
        SELECT f.id::text || ' ' || f.name FROM ({_FRESH}) f
        WHERE EXISTS (SELECT 1 FROM {USERS} u WHERE lower(u.username) = lower(f.name))
        ORDER BY 1
        """,
        "user_name 与已有账号只差大小写，先人工处理",
    )
    _require_empty(
        f"""
        SELECT f.id::text || ' ' || f.name FROM ({_FRESH}) f
        WHERE lower(f.name) IN (
            SELECT lower(x.name) FROM ({_FRESH}) x
            GROUP BY lower(x.name) HAVING count(DISTINCT x.name) > 1
        )
        ORDER BY 1
        """,
        "要建的占位账号之间只差大小写，先人工处理",
    )


def _placeholder_accounts() -> list[dict[str, object]]:
    """每个还没有账号的名字一个占位账号：没有角色、未验证，密码是随机的真哈希、谁也不知道。

    uuid5 与密码哈希在 SQL 里算不出来，所以在这里组好再插；哈希必须是密码库认得的，否则有人拿
    这个用户名走密码登录会抛异常，而不是正常的密码错误。
    """

    names = (
        op.get_bind()
        .execute(sa.text(f"SELECT DISTINCT f.name FROM ({_FRESH}) f ORDER BY 1"))
        .scalars()
        .all()
    )
    helper = PasswordHelper()
    return [
        {
            "id": uuid.uuid4(),
            "name": name,
            "email": f"{uuid.uuid5(_PLACEHOLDER_NAMESPACE, name).hex}@{_PLACEHOLDER_DOMAIN}",
            "password": helper.hash(secrets.token_urlsafe(32)),
        }
        for name in names
    ]


def downgrade() -> None:
    """属主校正修的是早先记错的事实，降级不改回；建的占位账号也留着，本人可能已经 SSO 认领。"""


def _require_empty(query: str, message: str, params: Mapping[str, object] | None = None) -> None:
    found = op.get_bind().execute(sa.text(query), dict(params or {})).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
