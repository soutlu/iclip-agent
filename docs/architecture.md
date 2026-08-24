# iclip-agent 架构文档

> **维护约定**：本文只记录现状，随实现同步更新——装配顺序、模块依赖、路由面、表结构变更时同步本文；未实现的部分不进本文。领域语言见 [CONTEXT.md](CONTEXT.md)，测试策略见 [test-design.md](test-design.md)。

## 1. 定位与运行拓扑

iclip-agent 是 Productor 视频创作产品的后端与合同主体：采用模块化单体架构 (Modular Monolith)，在单个代码库中管理（`server/` + `web/`）。**PostgreSQL 数据库是本系统全局唯一的事实源**。

认证方面，系统支持双主体身份体系（即 Cookie 会话用户 + Bearer API key 机器用户）。Agent 引擎层我们选定了 PydanticAI，并将其安全地隔离在 `harness` 围栏内；agent 的运行历史（run 血缘、逐步事件、可续跑快照、工具副作用账）落 Postgres 的 `agent_runtime` schema。模型经 `config.yaml` 的命名表装配，agent 在 `agents.yaml` 里引用名字。

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

围栏（tach + 架构测试强制）：`pydantic_ai` 只在 harness+capabilities；`pydantic_ai_harness` 仅 harness；`ag_ui`（AG-UI 协议包）仅 harness；`fastapi`/`starlette` 只在 app、`domains/identity/api.py`、`domains/agents/api.py`、`identity/middleware.py`、`identity/accounts.py`（fastapi-users 装配）、`main.py`；`sqlalchemy` 只在 `platform/db`、`domains/*/infra_sql.py`、app 组合根，外加 harness 环唯一 SQL 适配器 `harness/step_store_pg.py`；`openai` 只在 `harness/models.py`；`fastapi-users` 只在 identity。跨模块只准 import 对方 `public.py`。

现状：`harness/` 含官方 StepPersistence 协议的 PG 后端（见 §7）与 agent 装配（`agents.py`，声明格式见 §5、路由见 §8）；`capabilities/` 为空包占位（围栏已生效）。接口随首个实现定义，不提前写投机 ABC。

## 3. 目录布局

| 路径 | 职责 |
|------|------|
| `server/src/iclip/main.py` / `asgi.py` | CLI serve 入口 / ASGI 导出入口 |
| `server/src/iclip/app/` | **唯一组合根**：装配、entrypoints、lifespan |
| `server/src/iclip/config/` | RuntimeConfig（pydantic-settings YAML 源 + `*_env` 校验层） |
| `server/src/iclip/domains/identity/` | 唯一业务模块：八件套 + `middleware.py`（PrincipalResolver）+ `rbac.py` + `sso.py` + `pms.py` |
| `server/src/iclip/domains/agents/` | agent 运行的 HTTP 面：`api.py`（`/agents/{agent_id}/chat`），只认识注入的事件流工厂 |
| `server/src/iclip/harness/` | 通用 agent 内核；现含 `step_store_pg.py`（官方 StepPersistence / MediaStore 协议的 PG 后端）、`models.py`（命名模型装配）与 `agents.py`（agent 装配 + 官方协议事件流） |
| `server/src/iclip/capabilities/` | 空包占位：业务能力包 |
| `server/src/iclip/platform/` | `db/`（ownership 行级归属原语）、`http.py`（领域错误→HTTP 单点映射） |
| `server/src/iclip/common/` | 领域错误分类（`errors.py`：DomainError 及其五个子类） |
| `server/configs/config.yaml` | 唯一 Runtime Configuration（只存 `*_env` 名，不存密钥） |
| `server/agents/` | agent 装配声明 `agents.yaml` + 每 agent 一个子目录（`agent.yaml` 官方 spec + `instructions.md` 提示词） |
| `server/migrations/` | Alembic（0001 identity baseline；0002 agent_runtime 官方 harness 表） |
| `server/scripts/admin.py` | 引导型管理 CLI（set-roles / list-users / issue-key） |
| `web/` | UI 参考稿（只读） |
| `contract/` | 跨端合同契约存放处 |

## 4. 装配流程

1. `asgi.py` 读 `ICLIP_CONFIG_FILE`（缺省 `configs/config.yaml`）→ `load_runtime_config()`：只做 YAML 加载与结构校验（extra=forbid、拒绝未知字段），这一步不读任何环境变量。同时读 `ICLIP_AGENTS_FILE`（缺省 `agents/agents.yaml`）→ `load_agent_declarations()`：结构校验 + 把 `spec` 解析成绝对路径、按目录约定找出同级 `instructions.md`，文件缺失即报错（声明文件本身也必须存在：路径打错/部署漏目录必须大声失败，不降级成空注册表）。
2. 组合根 `app/bootstrap`：先 `resolve_settings()` 把 `*_env` 声明解析成真实值（运行必需的环境变量缺失即在此 fail fast）→ 构造 async engine（asyncpg，每 worker 一个连接池）→ 装配 identity 模块（repository → service → api）→ 可选 SSO/PMS 协议客户端（`WANGOON_SSO_BASE_URL` 空即不装）→ 把 agent 声明翻译成 harness 入参并 `build_agent_registry()`（模型/凭证/spec 缺失在此 fail fast）→ 新建唯一 FastAPI → 注册路由（healthz、auth、users、api-keys、可选 sso、agents）→ 安装 PrincipalResolver 中间件，`cors_allow_origins` 非空时再在其外层加装 CORS → lifespan（engine dispose）。
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
| `models` | 命名模型表：键名即模型名，值为 `provider` / `api`（`chat`\|`responses`，默认 chat）/ `api_key_env` / `base_url?` / `model?`（只在键名不是模型名时写） |
| `ops` | `log_level` |

另一份声明文件 `server/agents/agents.yaml`（路径由 `--agents` / `ICLIP_AGENTS_FILE` 给出）与 `config.yaml` 分工：那一份是运维配置，这一份是 agent 装配声明——启用哪些 agent、各自用哪份官方 spec、谁带谁。同样 frozen + `extra="forbid"`。**「没有 agent」由文件内容表达（`agent: {}`），不由文件缺席表达**——声明文件必须存在，否则报错。

```yaml
agent:                                 # 键名即 agent id
  storyboard:
    spec: storyboard/agent.yaml        # 相对本文件目录；同目录 instructions.md 自动并入
    model: qwen3.8-max                 # 引用 config.yaml models 段的键名，必填
  producer:
    spec: producer/agent.yaml
    model: qwen3.8-max
    subagent:                          # 有此段即主从，无此段即单 agent
      - spec: shot-writer/agent.yaml
        timeout_seconds: 180           # 本段三个字段名与 harness SubAgent 一致
        max_calls: 3
        on_failure: 就此收手
```

**模型由声明决定，不由 spec 决定**：`agents.yaml` 的 `model` 字段引用 `config.yaml` 的命名模型，spec 里的 `model:` 一律被覆盖（模型连着端点与密钥，属于运维决策）。引用了未声明的名字即装配期报错。spec 文件允许为空——模型在 `agents.yaml`、提示词在 `instructions.md`，spec 可以没内容可写。

**每个 agent（含子代理）装配时都挂官方 `StepPersistence`**，store 为 `PgStepStore`（见 §7）。组合根传入的 `step_store` 是必填参数、无内存兜底默认值——装配一个不落库的注册表在类型上就写不出来。子代理的 `parent_run_id` 由 harness 的 contextvar 自动推断，不需要手工穿线。

两条强制规则：**agent id 是唯一权威身份**——装配时以 `name=<id>` 覆盖 spec 里的 `name`，避免两个 id 指向同名 spec 后落库无法区分；子 agent 的 name 取自其 spec 所在**目录名**（同一条「身份来自声明而非 spec 内容」的规矩，因此空 `agent.yaml` 也能用）。**磁盘扫描必须显式关闭**（`agent_folders=None`）——harness 默认会扫 `<cwd>/.agents|.claude/agents/` 与家目录同名目录，否则开发者个人的 agent 定义会静默变成生产下属。

### 模型装配

`config.yaml` 的 `models` 段是一张命名表，`harness/models.py` 把每条声明变成一个官方 `Model`：

- **provider 名决定厂商适配**（schema 处理、严格输出开关、流式前导空白等），端点和 key 替代不了它。
- **「provider 名 → 哪个 Model 类」交给官方 `infer_model`**，本仓不自己维护分派表——OpenRouter / Cerebras / Crusoe / Snowflake / Ollama / Zai 虽属 OpenAI 兼容却各有专属模型类，抄一份必然走偏。我们只用 `provider_factory` 接管 provider 的构造：key 与端点一律来自配置，杜绝官方默认的隐式 env 读取与默认端点。
- **`api: responses` 是唯一越过官方分派的情况**：官方对多数 provider 默认给 Chat Completions，而百炼等厂商已支持 Responses；此时直接构造 `OpenAIResponsesModel` 并塞入我们的 provider（厂商 profile 照常生效）。写在非 OpenAI 兼容的 provider 上即装配期报错。
- 各家构造签名不统一：收 `base_url` 的直接传，只收 `api_key` 的走 `openai_client`。
- 同名只造一个实例，被多个 agent 引用时共用连接池。

加一家的成本：构造签名是 `api_key`/`base_url`/`openai_client` 三者之一的（Anthropic、Google、Groq、Mistral 等），装上对应 extra 即可，代码零改动。

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
| `POST /agents/{agent_id}/chat` | `agent:run` | 官方 AG-UI 协议流（`text/event-stream`，请求体为官方 `RunAgentInput`）。强制 `Content-Type: application/json`，否则 415；未注册 id 404；请求体形状不合法 422 |
| `OPTIONS /agents/{agent_id}/chat` | 公开 | 204 且**刻意不带任何 `Access-Control-Allow-*` 头**：与上面的 content-type 要求组成一对 CSRF 防线（免检 content-type 都能塞 JSON 且不触发预检，故要求非免检类型来强制预检，再在此拒掉） |

## 9. 运维

- `scripts/admin.py`：`set-roles <username> <role1,role2>`、`list-users`、`issue-key`——直连 DB 绕过 API，专为非 SSO 场景的 root 引导设计（SSO 场景用 `ICLIP_ROOT_EMAIL`）。
- 日志：structlog（结构化，级别来自 `ops.log_level`）。观测尚未接入。
- 测试门禁与命令：见 [test-design.md](test-design.md) 与 [../AGENTS.md](../AGENTS.md)。
