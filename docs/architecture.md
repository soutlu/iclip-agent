# iclip-agent 架构文档

> **维护约定**：本文只记录现状，随实现同步更新——装配顺序、模块依赖、路由面、表结构变更时同步本文；未实现的部分不进本文。领域语言见 [CONTEXT.md](CONTEXT.md)，测试策略见 [test-design.md](test-design.md)。

## 1. 定位与运行拓扑

iclip-agent 是 Productor 视频创作产品的后端与合同主体：采用模块化单体架构 (Modular Monolith)，在单个代码库中管理（`server/` + `web/`）。**PostgreSQL 数据库是本系统全局唯一的事实源**。

认证方面，系统支持双主体身份体系（即 Cookie 会话用户 + Bearer API key 机器用户）。Agent 引擎层我们选定了 PydanticAI，并将其安全地隔离在 `harness` 围栏内（目前后端已实现基于 Postgres 的运行历史持久化，但完整的 Agent 运行面暂未装配）。

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
╰────────────────────┬────────────────────╯
                     ▼
    ╭────────────────────────────────╮
    │ Postgres                       │
    │  iclip + agent_runtime schema  │
    ╰────────────────────────────────╯
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

围栏（tach + 架构测试强制）：`pydantic_ai` 只在 harness+capabilities；`pydantic_ai_harness` 仅 harness；`fastapi` 只在 app、`domains/*/api.py`、`identity/middleware.py`、`identity/accounts.py`（fastapi-users 装配）、`main.py`；`sqlalchemy` 只在 `platform/db`、`domains/*/infra_sql.py`、app 组合根，外加 harness 环唯一 SQL 适配器 `harness/step_store_pg.py`；`fastapi-users` 只在 identity。跨模块只准 import 对方 `public.py`。

现状：`harness/` 含官方 StepPersistence 协议的 PG 后端（见 §7）；`capabilities/` 为空包占位（围栏已生效）。接口随首个实现定义，不提前写投机 ABC。

## 3. 目录布局

| 路径 | 职责 |
|------|------|
| `server/src/iclip/main.py` / `asgi.py` | CLI serve 入口 / ASGI 导出入口 |
| `server/src/iclip/app/` | **唯一组合根**：装配、entrypoints、lifespan |
| `server/src/iclip/config/` | RuntimeConfig（pydantic-settings YAML 源 + `*_env` 校验层） |
| `server/src/iclip/domains/identity/` | 唯一业务模块：八件套 + `middleware.py`（PrincipalResolver）+ `rbac.py` + `sso.py` + `pms.py` |
| `server/src/iclip/harness/` | 通用 agent 内核；现含 `step_store_pg.py`（官方 pydantic_ai_harness StepPersistence / MediaStore 协议的 PG 后端） |
| `server/src/iclip/capabilities/` | 空包占位：业务能力包 |
| `server/src/iclip/platform/` | `db/`（ownership 行级归属原语）、`http.py`（领域错误→HTTP 单点映射） |
| `server/src/iclip/common/` | 领域错误分类（`errors.py`：DomainError 及其五个子类） |
| `server/configs/config.yaml` | 唯一 Runtime Configuration（只存 `*_env` 名，不存密钥） |
| `server/migrations/` | Alembic（0001 identity baseline；0002 agent_runtime 官方 harness 表） |
| `server/scripts/admin.py` | 引导型管理 CLI（set-roles / list-users / issue-key） |
| `web/` | UI 参考稿（只读） |
| `contract/` | 跨端合同契约存放处 |

## 4. 装配流程

1. `asgi.py` 读 `ICLIP_CONFIG_FILE`（缺省 `configs/config.yaml`）→ `load_runtime_config()`：只做 YAML 加载与结构校验（extra=forbid、拒绝未知字段），这一步不读任何环境变量。
2. 组合根 `app/bootstrap`：先 `resolve_settings()` 把 `*_env` 声明解析成真实值（运行必需的环境变量缺失即在此 fail fast）→ 构造 async engine（asyncpg，每 worker 一个连接池）→ 装配 identity 模块（repository → service → api）→ 可选 SSO/PMS 协议客户端（`WANGOON_SSO_BASE_URL` 空即不装）→ 新建唯一 FastAPI → 注册路由（healthz、auth、users、api-keys、可选 sso）→ 安装 PrincipalResolver 中间件，`cors_allow_origins` 非空时再在其外层加装 CORS → lifespan（engine dispose）。
3. 启动期**不做任何业务表 provisioning**；表结构只经人工 `make db-upgrade` 演进。

## 5. 配置系统

单文件 `server/configs/config.yaml`，pydantic-settings `YamlConfigSettingsSource` 加载，全部模型 frozen + `extra="forbid"`。**YAML 只存 env 变量名**（`*_env` 字段），bootstrap 从环境读取值：

| Section | 内容 |
|---------|------|
| `app` | 服务名 |
| `db` | `url_env`、`schema`（默认 `iclip`） |
| `security` | `secret_env`、cookie 名（`iclip_session`）/secure/有效期、`cors_allow_origins`（禁 `"*"`） |
| `sso` | `base_url_env`（env 空即 SSO 关闭）、`app_name`、`redirect_url_env`、`root_email_env`（该邮箱 SSO 登录即持有 root；env 空即关闭引导） |
| `pms` | `base_url_env`（env 空即关闭 PMS 资料同步） |
| `ops` | `log_level` |

## 6. identity 模块（双主体）

- **Principal**：`kind ∈ {user, api_key}` + `user_id` + `api_key_id?` + 生效权限集。PrincipalResolver 每 hop 只解析一次：cookie → JWT 验签一次 + 活跃用户加载一次；Bearer → SHA-256 查表 + 活跃 key/属主加载（过期/吊销/属主停用即拒）。写入 `request.state.principal`。中间件对 http 与 websocket 两种连接都建立 principal，但**只解析、不拒绝**；产品侧目前还没有任何 WS 端点。来源校验以 `websocket_origin_allowed`（无 Origin 放行 / 白名单跨域 / 否则同源）提供，**需要 WS 端点自己调用、并在不通过时 close 1008**——中间件不会代劳。
- **账号**：fastapi-users（cookie transport + JWT strategy）；登录支持 username 或 email；密码注册强制 `viewer`；登录 204 + Set-Cookie，响应体不含 token。
- **SSO**（identity-provider 模式）：跳转 `{base}/sso/issue/jwt?redirect_uri=...&_fromApp=...`；验证 `GET {base}/sso/rpc/session/verify?jwt=...` → `{result:"OK", userSession:{innerUserId, unionId, name, email, avatarUrl}}`；PMS `GET {base}/pms-console/user/selectUserById/{innerUserId}`（Authorization: SSO jwt）→ `{success:true, data:{city, jobTitle, depts:[...]}}`。callback 内 verify → PMS（**失败显式终止**）→ fastapi-users oauth 关联（`associate_by_email`，`oauth_name="wangoon_sso"`，首登默认 editor）→ 铸自有 cookie。此后普通请求零外呼。
- **API key**：`iclip_sk_` + 32 字节 urlsafe base64；只存哈希 + 前缀；签发需 `api_keys:issue`（仅 root 角色持有），授予集签发时校验 ⊆ 签发者当下权限；解析时有效权限即 key 显式授权集（不随属主角色变化；属主停用/吊销/过期即 401）。本人管理自己的 key，`users:manage` 管全部。
- **权限体系**：授权的唯一货币是权限集合（[adr/0002](adr/0002-unified-permission-model.md)）。用户有效权限 = 所分配角色的权限并集 ∪ 直接授权；角色是代码内预置的权限集合快捷方式（root/editor/viewer，root = 全量计算），无角色管理表。`require_permission(perm)` 只读 Principal。行级归属：不可见 `NotFound`、可见无权 `PermissionDenied`（`platform.db.ownership.scope_to_owner` 为防 IDOR 统一原语）。

## 7. 数据模型与迁移

| 表（schema=iclip） | 用途 | 关键点 |
|----|------|--------|
| `users` | 账号（fastapi-users） | UUID PK、email 唯一、username 唯一可空、`roles` JSONB（默认 `["viewer"]`）、`direct_permissions` JSONB、PMS `city`/`job_title`/`departments` JSONB、`last_login_at` |
| `oauth_accounts` | SSO 外部身份 | FK → users 级联删除、`oauth_name=wangoon_sso` |
| `api_keys` | 机器凭证 | `owner_user_id` FK、`token_hash` 唯一、`token_prefix`、`permissions` JSONB、`expires_at`/`revoked_at`/`last_used_at` |

| 表（schema=agent_runtime） | 用途 | 关键点 |
|----|------|--------|
| `runs` | Agent 运行血缘（run_id / conversation_id / parent_run_id） | 结构严格镜像官方 pydantic_ai_harness StepPersistence 存储形状（本仓决策：只换数据库实现，不改表结构） |
| `events` | append-only 逐步事件 | 同上；`(run_id, seq)` 索引 |
| `snapshots` | 可续跑的消息历史快照 | 同上；`state ∈ {complete, interrupted}`；`messages` 存 JSON 文本（text，非 jsonb） |
| `tool_effects` | 工具副作用账 | 同上；PK `(run_id, tool_call_id)` upsert |
| `media` | 内容寻址媒体（sha256 主键） | 同上；≥64KiB 负载自快照外置 |

写入方：`harness/step_store_pg.py`（实现官方异步 `StepStore` / `MediaStore` 协议，挂到 `Agent(capabilities=[StepPersistence(...)])`）；DDL 由 Alembic 0002 拥有，store 不自建表。

唯一 provisioning 路径：人工 `make db-upgrade`（`alembic upgrade head`，所有环境一致）；迁移契约测试用 scratch 环境验证 head 与 identity 的 ORM 元数据零漂移——该断言只覆盖 `iclip` schema，`agent_runtime` 这五张表另挂一份独立元数据，不在断言范围内。

## 8. 路由面

| 方法 & 路径 | 权限 | 说明 |
|------------|------|------|
| `GET /healthz` | 公开 | 存活探针 |
| `POST /auth/register` / `POST /auth/login` | 公开 | 注册默认 viewer；登录 204 + Set-Cookie |
| `POST /auth/logout` | 登录 | 清 cookie |
| `GET /auth/sso/authorize` / `GET /auth/sso/callback` | 公开（SSO 启用时；关闭即 404） | 见 §6 |
| `GET /users/me` | 任意活跃主体 | `{user:{...}}` 信封，camelCase，含 roles/directPermissions/permissions/city/jobTitle/departments |
| `GET /users`、`PATCH /users/{id}` | users:manage | 用户列表 / 调整角色与直接授权（不能改自己的授权或停用自己） |
| `POST /api-keys` | `api_keys:issue`（仅 root **角色**持有；也可经直接授权单独授予）；api key 主体一律被拒 | 创建响应含一次性明文；属主恒为调用者本人 |
| `GET /api-keys`、`DELETE /api-keys/{id}` | 登录（本人）；users:manage 管全部 | 列表只返回展示前缀 |

## 9. 运维

- `scripts/admin.py`：`set-roles <username> <role1,role2>`、`list-users`、`issue-key`——直连 DB 绕过 API，专为非 SSO 场景的 root 引导设计（SSO 场景用 `ICLIP_ROOT_EMAIL`）。
- 日志：structlog（结构化，级别来自 `ops.log_level`）。观测尚未接入。
- 测试门禁与命令：见 [test-design.md](test-design.md) 与 [../AGENTS.md](../AGENTS.md)。
