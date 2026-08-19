# iclip-agent 架构文档

> **维护约定**：随实现同步更新——装配顺序、模块依赖、路由面、表结构变更时同步本文。当前版本反映 **M0 地基**；后续范围与顺序由用户决定。领域语言见 [CONTEXT.md](CONTEXT.md)，测试策略见 [test-design.md](test-design.md)。

## 1. 定位与运行拓扑

iclip-agent 是 Productor 视频创作产品的重写主体：模块化单体 monorepo（`server/` + `web/`）。**Postgres 是唯一事实源**；认证支持双主体（cookie 用户 + Bearer API key）；Agent 引擎为 PydanticAI（M1 接入，关在 harness 围栏内）。

```text
╭──────────────╮   ╭──────────────────╮
│ web/（浏览器） │   │ 机器调用方         │
│ cookie 会话   │   │ Bearer iclip_sk_ │
╰──────┬───────╯   ╰────────┬─────────╯
       │  同源 /api（反代 rewrite）│
       ▼                    ▼
╭─────────────────────────────────────────╮
│ server/ FastAPI（每 worker 一份）          │
│  PrincipalResolver（唯一信任点）           │
│  /healthz /auth/* /users/* /api-keys/*   │
│  M1 起：/agui/* · sessions · workspace    │
╰────────────────────┬────────────────────╯
                     ▼
          ╭─────────────────────╮
          │ Postgres（schema=iclip）│
          ╰─────────────────────╯
```

## 2. 三环分层

```text
╭──────────────────────── app（组合根，可 import 一切） ───────────────────────╮
│                                                                            │
│   ╭─────────────╮        ╭──────────────╮        ╭────────────────────╮    │
│   │  harness/   │◀───────│ capabilities/ │───────▶│     domains/       │    │
│   │ 通用内核     │        │ 业务能力包     │        │ 业务模块（六边形）    │    │
│   │             │   ✗    │              │        │                    │    │
│   │ 不认识业务    │◀──╳────┼──────────────┼───╳───▶│ 不认识 pydantic_ai  │    │
│   ╰─────────────╯  禁止   ╰──────────────╯  禁止   ╰────────────────────╯    │
│         │                                              │                   │
│         ╰──────────────────┬───────────────────────────╯                   │
│                            ▼                                               │
│                  ╭──────────────────╮                                      │
│                  │ platform + common │                                     │
│                  ╰──────────────────╯                                      │
╰────────────────────────────────────────────────────────────────────────────╯
```

围栏（tach + 架构测试强制）：`pydantic_ai`/`ag_ui` 只在 harness+capabilities；`pydantic_ai_harness` 仅 harness；`fastapi` 只在 app、`domains/*/api.py`、`identity/middleware.py`、`identity/accounts.py`（fastapi-users 装配）、`main.py`；`sqlalchemy` 只在 `platform/db`、`domains/*/infra_sql.py`、app 组合根；`fastapi-users` 只在 identity。跨模块只准 import 对方 `public.py`。

M0 现状：`harness/`、`capabilities/` 为空包预留（围栏已生效）；六接缝（RunTarget / CapabilityContract / ConversationStore / RunLedger / EventJournal / Policy 执法层）的接口随 M1 首个实现定义，不提前写投机 ABC。

## 3. 目录布局

| 路径 | 职责 |
|------|------|
| `server/src/iclip/main.py` / `asgi.py` | CLI serve 入口 / ASGI 导出入口 |
| `server/src/iclip/app/` | **唯一组合根**：装配、entrypoints、lifespan |
| `server/src/iclip/config/` | RuntimeConfig（pydantic-settings YAML 源 + `*_env` 校验层） |
| `server/src/iclip/domains/identity/` | M0 唯一业务模块：八件套 + `middleware.py`（PrincipalResolver）+ `rbac.py` + `sso.py` + `pms.py` |
| `server/src/iclip/harness/` | M1 起：engine、conversation、agui、workspace、skills |
| `server/src/iclip/capabilities/` | M2 起：业务能力包 |
| `server/src/iclip/platform/` | `db/`（引擎句柄、ownership）、`http.py`（领域错误→HTTP 单点映射） |
| `server/src/iclip/common/` | 错误分类、typed id、路径安全 |
| `server/configs/config.yaml` | 唯一 Runtime Configuration（只存 `*_env` 名，不存密钥） |
| `server/migrations/` | Alembic（0001 identity baseline） |
| `server/scripts/admin.py` | 引导型管理 CLI（set-role / list-users / issue-key） |
| `server/assets/` | prompt 四件套 + SKILL.md 资产（M1 起迁入） |
| `web/` | Producer 前端纯拷贝迁入，冻结 |
| `contract/` | 跨端合同：conventions.md + golden fixtures v2（M1 起） |

## 4. 装配流程

1. `asgi.py` 读 `ICLIP_CONFIG_FILE`（缺省 `configs/config.yaml`）→ `load_runtime_config()`：YAML 加载（extra=forbid、拒绝未知字段）+ `*_env` 解析（运行必需 env 缺失即 fail fast）。
2. 组合根 `app/bootstrap`：构造 async engine（asyncpg，每 worker 一个连接池）→ 装配 identity 模块（repository → service → api）→ 可选 SSO/PMS 协议客户端（`WANGOON_SSO_BASE_URL` 空即不装）→ 新建唯一 FastAPI，安装 PrincipalResolver 中间件 → 注册路由（healthz、auth、users、api-keys、可选 sso）→ lifespan（engine dispose）。
3. 启动期**不做任何业务表 provisioning**；表结构只经人工 `make db-upgrade` 演进。

## 5. 配置系统

单文件 `server/configs/config.yaml`，pydantic-settings `YamlConfigSettingsSource` 加载，全部模型 frozen + `extra="forbid"`。**YAML 只存 env 变量名**（`*_env` 字段），bootstrap 从环境读取值：

| Section | 内容 |
|---------|------|
| `app` | 服务名 |
| `db` | `url_env`、`schema`（默认 `iclip`） |
| `security` | `secret_env`、cookie 名（`iclip_session`）/secure/有效期、`cors_allow_origins`（禁 `"*"`） |
| `sso` | `base_url_env`（env 空即 SSO 关闭）、`app_name`、`redirect_url_env` |
| `pms` | `base_url_env`（env 空即关闭 PMS 资料同步） |
| `ops` | `log_level` |

## 6. identity 模块（双主体）

- **Principal**：`kind ∈ {user, api_key}` + `user_id` + `api_key_id?` + 生效权限集。PrincipalResolver 每 hop 只解析一次：cookie → JWT 验签一次 + 活跃用户加载一次；Bearer → SHA-256 查表 + 活跃 key/属主加载（过期/吊销/属主停用即拒）。写入 `request.state.principal`；WS 握手复用同一解析 dependency（cookie 走 Origin 校验：无 Origin 放行 / 白名单跨域 / 否则同源，拒绝 close 1008）。
- **账号**：fastapi-users（cookie transport + JWT strategy）；登录支持 username 或 email；密码注册强制 `viewer`；登录 204 + Set-Cookie，响应体不含 token。
- **SSO**（identity-provider 模式）：跳转 `{base}/sso/issue/jwt?redirect_uri=...&_fromApp=...`；验证 `GET {base}/sso/rpc/session/verify?jwt=...` → `{result:"OK", userSession:{innerUserId, unionId, name, email, avatarUrl}}`；PMS `GET {base}/pms-console/user/selectUserById/{innerUserId}`（Authorization: SSO jwt）→ `{success:true, data:{city, jobTitle, depts:[...]}}`。callback 内 verify → PMS（**失败显式终止**）→ fastapi-users oauth 关联（`associate_by_email`，`oauth_name="wangoon_sso"`，首登默认 editor）→ 铸自有 cookie。此后普通请求零外呼。
- **API key**：`iclip_sk_` + 32 字节 urlsafe base64；只存哈希 + 前缀；授予集在创建时校验 ⊆ 属主权限，解析时取交集。本人管理自己的 key，`users:manage` 管全部。
- **RBAC**：单一产品权限词汇表由 `identity/rbac.py` 单点定义；`require_permission(perm)` 只读 Principal。行级归属：不可见 `NotFound`、可见无权 `PermissionDenied`（`platform.db.ownership.scope_to_owner` 为防 IDOR 统一原语）。

## 7. 数据模型与迁移

| 表（schema=iclip） | 用途 | 关键点 |
|----|------|--------|
| `users` | 账号（fastapi-users） | UUID PK、email 唯一、username 唯一可空、`role` 默认 viewer、PMS `city`/`job_title`/`departments` JSONB、`last_login_at` |
| `oauth_accounts` | SSO 外部身份 | FK → users 级联删除、`oauth_name=wangoon_sso` |
| `api_keys` | 机器凭证 | `owner_user_id` FK、`token_hash` 唯一、`token_prefix`、`permissions` JSONB、`expires_at`/`revoked_at`/`last_used_at` |

唯一 provisioning 路径：人工 `make db-upgrade`（`alembic upgrade head`，所有环境一致）；迁移契约测试用 scratch 环境验证 head 与聚合元数据零漂移。

## 8. 路由面（M0）

| 方法 & 路径 | 权限 | 说明 |
|------------|------|------|
| `GET /healthz` | 公开 | 存活探针 |
| `POST /auth/register` / `POST /auth/login` | 公开 | 注册默认 viewer；登录 204 + Set-Cookie |
| `POST /auth/logout` | 登录 | 清 cookie |
| `GET /auth/sso/authorize` / `GET /auth/sso/callback` | 公开（SSO 启用时；关闭即 404） | 见 §6 |
| `GET /users/me` | 任意活跃主体 | `{user:{...}}` 信封，camelCase，含 role/permissions/city/jobTitle/departments |
| `GET /users`、`PATCH /users/{id}` | users:manage | 用户列表 / 改角色 |
| `POST /api-keys`、`GET /api-keys`、`DELETE /api-keys/{id}` | 登录（本人）；users:manage 管全部 | 创建响应含一次性明文 |

M1 增补：`/agui/*` 命令面、sessions、workspace 路由。

## 9. 运维

- `scripts/admin.py`：`set-role <username> <role>`、`list-users`、`issue-key`——直连 DB 绕过 API，专为「第一个 admin」引导设计。
- 日志：structlog（结构化，级别来自 `ops.log_level`）。观测接入（OTLP → Langfuse）随 M1 引擎接入落地。
- 测试门禁与命令：见 [test-design.md](test-design.md) 与 [../AGENTS.md](../AGENTS.md)。
