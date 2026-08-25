# iclip-agent 架构文档

> **维护约定**：本文只记录现状，随实现同步更新——装配顺序、模块依赖、路由面、表结构变更时同步本文；未实现的部分不进本文。领域语言见 [CONTEXT.md](CONTEXT.md)，测试策略见 [test-design.md](test-design.md)。

## 1. 定位与运行拓扑

iclip-agent 是 Productor 视频创作产品的后端与合同主体：采用模块化单体架构 (Modular Monolith)，在单个代码库中管理（`server/` + `web/`）。**PostgreSQL 数据库是本系统全局唯一的事实源**。

认证方面，系统支持双主体身份体系（即 Cookie 会话用户 + Bearer API key 机器用户）。Agent 引擎层我们选定了 PydanticAI，并将其安全地隔离在 `harness` 围栏内；agent 的运行历史（run 血缘、逐步事件、可续跑快照、工具副作用账）落 Postgres 的 `agent_runtime` schema。模型经 `config.yaml` 的命名表装配，agent 在 `agents.yaml` 里引用名字。

agent 运行不绑在发起它的 HTTP 请求上：运行在后台跑，事件写进 Redis 的一条可重放流，HTTP 只订阅（见 §10 与 [adr/0003](adr/0003-detached-runs-and-replayable-streams.md)）。**Redis 只承载在途与近期的事件流，不是事实源**；持久事实照旧只在 Postgres。

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
│  /agents/*（发起运行 / 接着读事件）         │
╰──────┬───────────────────────┬──────────╯
       ▼                       ▼
╭──────────────────╮  ╭────────────────────────────────╮
│ Redis            │  │ Postgres                       │
│  在途/近期事件流   │  │  iclip + agent_runtime schema  │
│  （可重放，非事实源）│  │  （唯一事实源）                  │
╰──────────────────╯  ╰────────────────────────────────╯
```

## 2. 三环分层

```text
╭──────────────────────── app（组合根，可 import 一切） ───────────────────────╮
│                                                                            │
│   ╭─────────────╮        ╭──────────────╮        ╭────────────────────╮    │
│   │  harness/   │◀───────│ capabilities/ │───────▶│     domains/       │    │
│   │ 通用内核     │        │ capability     │        │ 业务模块（六边形）    │    │
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

围栏（tach + 架构测试强制，只走 `server/src/`——测试代码不在围栏内）：`pydantic_ai` 只在 harness+capabilities；`pydantic_ai_harness` 仅 harness；`ag_ui`（AG-UI 协议包）仅 harness；`fastapi`/`starlette` 只在 app、`domains/identity/api.py`、`domains/agents/api.py`、`domains/conversations/api.py`、`domains/generation/api.py`、`domains/products/api.py`、`domains/inspirations/api.py`、`domains/tasks/api.py`、`identity/middleware.py`、`identity/accounts.py`（fastapi-users 装配）、`main.py`；`sqlalchemy` 只在 `platform/db`、`platform/file_store/`、app 组合根、各模块自己的 `infra_sql.py`（`domains/*`、`capabilities/*`），外加协议后端 `harness/step_store_pg.py` 与读外部只读源的 `domains/products/catalog_pg.py`、`domains/inspirations/catalog_pg.py`；`redis` 只在 `harness/run_stream_redis.py` 与 app 组合根（建客户端）；`openai` 只在 `harness/models.py`；`oss2` 只在 `platform/object_store/`；`procrastinate` 只在 `domains/generation/queue.py`（说这门话的唯一地方）、`domains/generation/module.py`（签名里要写连接器的类型）与 app 组合根（造那个连接器——用哪个数据库驱动是组合根的决定）；`fastapi-users` 只在 identity。跨模块只准 import 对方 `public.py`。

现状：`harness/` 含官方 StepPersistence 协议的 PG 后端（见 §7）与 agent 装配（`agents.py`，声明格式见 §5、路由见 §8）；`capabilities/` 含 `workspace/`（agent 的持久文本工作区，见 §5）与 `shot_video/`（镜头素材，见 §5），**能力包之间互不 import**——两件能力要共用的东西下沉到 `platform/` 做成协议，组合根把同一个实例递给两边；`platform/` 含 `file_store/`（命名空间化文本文件存储，工作区的后端）；`domains/` 含 `identity/`（见 §6）、`agents/`（agent 运行的 HTTP 面）、`conversations/`（对话，见 §12）、`generation/`（媒体生成，见 §11）、`products/`（产品资料查询，见 §13）、`tasks/`（创作需求单，见 §14）与 `inspirations/`（爆款视频查询，见 §15）。接口随首个实现定义，不提前写投机 ABC。

**外部存储落点（登记表，不是配额）**：新增一个碰 SQL/Redis 的文件不是违规，是要登记——在架构测试的 `FRAMEWORK_FENCES` 加一行，并在下表加一行。落在哪一环有两条并列规则：**实现官方协议的后端**跟着「说这门协议的那一环」走；**模块或能力包自有的存储**放自己模块里的 `infra_sql.py`。

| 落点 | 存储 | 为什么在这一环 |
|---|---|---|
| `platform/db/` | SQL 构件 | 跨模块复用的查询原语（`scope_to_owner`），不是 store |
| `harness/step_store_pg.py` | PG | 官方 `StepStore`/`MediaStore` 协议的后端；harness 是说这门协议的那一环 |
| `harness/run_stream_redis.py` | Redis | 运行事件流是 harness 自己的机制 |
| `domains/*/infra_sql.py` | PG | 该 domain 自有的表 |
| `platform/object_store/` | OSS | 公开对象存储的适配器；业务侧只认 `PublicObjectStore` 协议 |
| `platform/file_store/` | PG | 命名空间化文本文件存储的后端（表 `agent_runtime.workspace_files`）；能力侧只认 `FileStore` 协议 |
| `capabilities/*/infra_sql.py` | PG | 该能力包自有的表 |
| `domains/inspirations/catalog_pg.py` | PG（外部只读源） | 数仓的爆款榜与视频打标结果，同样不是本模块自有的表 |
| `domains/products/catalog_pg.py` | PG（外部只读源） | 这些表是别人的（PDM 的同步副本），不是本模块自有的表——所以不叫 `infra_sql.py`，那个名字在本表里的口径是「自有」|
| `app/` | 建 engine 与 Redis 客户端 | 唯一组合根 |

## 3. 目录布局

| 路径 | 职责 |
|------|------|
| `server/src/iclip/main.py` / `asgi.py` | CLI serve 入口 / ASGI 导出入口 |
| `server/src/iclip/app/` | **唯一组合根**：装配、entrypoints、lifespan + `capability_table.py`（capability 的名字表） |
| `server/src/iclip/config/` | RuntimeConfig：YAML 源（形状）+ 那几个 `*Env` 类（环境变量清单） |
| `server/src/iclip/domains/identity/` | 唯一业务模块：八件套 + `middleware.py`（PrincipalResolver）+ `rbac.py` + `sso.py` + `pms.py` |
| `server/src/iclip/domains/agents/` | agent 运行的 HTTP 面：`api.py`（发起运行 + 接着读事件）、`public.py`（`AgentRunDeps`：一次运行的身份 + 所属对话），只认识注入进来的运行入口 |
| `server/src/iclip/domains/conversations/` | 对话（会话）：`models.py`（对话行）、`repository.py`/`infra_sql.py`（自有的表）、`schemas.py`（wire 形状）、`service.py`（含删除时连带清理的口子）、`api.py`/`module.py`。不认识 agent 引擎，也不认识工作区 |
| `server/src/iclip/domains/generation/` | 媒体生成：`schemas.py`（请求类型，同时是 wire 与入库形状）、`models.py`（job 行）、`repository.py`/`infra_sql.py`（只有事实，没有排期）、`provider.py` + `multiflow.py`（视频）/`nano_banana.py`（图像）、`queue.py`（三条队列 + 任务体 + 捡卡死任务）、`service.py`/`api.py`/`module.py` |
| `server/src/iclip/domains/products/` | 产品资料查询：`catalog_pg.py`（外部只读源的唯一 SQL 出口）、`tables.py`（码→名字的三张常量表）、`models.py`/`schemas.py`/`api.py`/`module.py`。自己不建表 |
| `server/src/iclip/domains/inspirations/` | 爆款视频查询：`catalog_pg.py`（外部只读源的唯一 SQL 出口）、`models.py`/`schemas.py`/`api.py`/`module.py`。自己不建表 |
| `server/src/iclip/domains/tasks/` | 创作需求单：`schemas.py`（brief 的类型，同时是 wire 与入库形状）、`models.py`（需求单行 + 状态常量）、`repository.py`/`infra_sql.py`（自有的表；写方法都带状态守卫）、`service.py`（状态机 + 冻结规则 + 谁能改）、`api.py`/`module.py`。不依赖任何别的业务模块 |
| `server/src/iclip/harness/` | 通用 agent 内核；现含 `step_store_pg.py`（官方 StepPersistence / MediaStore 协议的 PG 后端）、`models.py`（命名模型装配）、`agents.py`（agent 装配 + 官方协议事件流）、`skills.py`（skill 库装配 + 读 references 的工具）、`runs.py`（后台运行与可重放流）、`run_stream_redis.py`（事件流的 Redis 后端）、`media.py`（媒体引用协议：前端形状 ↔ 模型形状）与 `materials.py`（素材范围：从消息里算出模型能交给工具的地址，见 §5） |
| `server/src/iclip/capabilities/` | capability 实现（落地一件就在 `app/capability_table.py` 登记名字）；现含 `workspace/`：`capability.py`（能力本体 + 六件工具）、`scope.py`（工作区归谁：运行 → 命名空间的规则）；与 `shot_video/`：`capability.py`（四件工具）、`shots.py`（镜头区间解析 + 等间隔采样，纯计算）、`board.py`（预览板拼版与帧号叠印）、`grid.py`（切格几何，纯函数）、`prompt.py`（整版 prompt 拼接）、`ffmpeg.py`（异步子进程 + 取素材）、`parser.py`（视频拆解的 Responses 适配器 + 提示词）、`ports.py`（对外要的三个窄协议）。能力包之间互不 import |
| `server/src/iclip/platform/` | `db/`（ownership 行级归属原语）、`http.py`（领域错误→HTTP 单点映射）、`object_store/`（公开对象存储，阿里云 OSS）、`file_store/`（命名空间化文本文件存储：`store.py` 路径语法 + `FileStore` 协议 + `FileSpace`「存储 × 命名空间规则」，`pg.py` PG 后端） |
| `server/src/iclip/common/` | 领域错误分类（`errors.py`：DomainError 及其五个子类） |
| `server/configs/config.yaml` | 唯一 Runtime Configuration（只有形状；地址与凭证在环境变量里） |
| `server/agents/` | agent 装配声明 `agents.yaml` + 每 agent 一个子目录（`agent.yaml` 官方 spec + `instructions.md` 提示词）+ `skills/`（skill 库，一个子目录一个 skill） |
| `server/migrations/` | Alembic（0001 identity baseline；0002 agent_runtime 官方 harness 表；0003 工作区文件表；0004 媒体生成任务表；0005 procrastinate 的排期表；0006 去掉 0004 里的排期列；0007 对话表；0008 创作需求单表） |
| `server/scripts/admin.py` | 引导型管理 CLI（set-roles / list-users / issue-key） |
| `web/` | UI 参考稿（只读） |
| `contract/` | 跨端合同契约存放处 |

## 4. 装配流程

1. `asgi.py` 读 `CONFIG_FILE`（缺省 `configs/config.yaml`）→ `load_runtime_config()`：只做 YAML 加载与结构校验（extra=forbid、拒绝未知字段），这一步不读任何环境变量。同时读 `AGENTS_FILE`（缺省 `agents/agents.yaml`）→ `load_agent_declarations()`：结构校验 + 把 `spec` 解析成绝对路径、按目录约定找出同级 `instructions.md`、声明了 `skills` 时把同级 `skills/` 库解析成绝对路径，文件或目录缺失即报错（声明文件本身也必须存在：路径打错/部署漏目录必须大声失败，不降级成空注册表）。
2. 组合根 `app/bootstrap`：先 `resolve_settings()` 把 YAML 的形状与环境变量的值合成运行值（缺哪几个变量在此一次全报出来）→ 构造 async engine（asyncpg，每 worker 一个连接池）→ 装配 identity 模块（repository → service → api）→ 可选 SSO/PMS 协议客户端（`SSO_BASE_URL` 空即不装）→ 装 conversations 模块（它要一个「删对话时连带清掉派生物」的回调，组合根在这里把它接到工作区的清空上——对话那侧不认识工作区，工作区那侧也不认识对话，只有组合根同时认识两者）→ 装 tasks 模块（只要一张自己的表，没有开关，也不认识别的模块）→ 开了媒体生成时装 generation 模块（`media_generation` 段 + `VIDEO_SUBMIT_URL` 非空；两家 provider 与对象存储一起装，缺一个 env 即报错）→ 开了镜头素材能力时建它取素材用的 HTTP 客户端并检查 PATH 上有 ffmpeg/ffprobe → 配了产品资料目录 / 爆款视频库时各建一个只读 engine 并装对应模块（两个连接都在会话层设成只读）→ 把 agent 声明翻译成 harness 入参并 `build_agent_registry()`（模型/凭证/spec 缺失在此 fail fast；capability 名字表在这一步建起来，所以生成模块要排在它前面——`shot_video` 用的是生成域的服务与对象存储）→ 声明了 agent 时再建 Redis 客户端与运行 broker（`redis` 段缺席即报错；没有 agent 就整组路由不挂）→ 新建唯一 FastAPI → 注册路由（healthz、auth、users、api-keys、可选 sso、开了生成时的 generations、conversations、配了目录时的 products 与 inspirations、tasks、有 agent 时的 agents）→ 安装 PrincipalResolver 中间件，`cors_allow_origins` 非空时再在其外层加装 CORS → lifespan 启动时先开队列连接（HTTP 面受理时就要往队列里排）再起三个 worker；关停顺序：**先收 worker 与队列连接、再收后台运行，然后关镜头素材的 HTTP 客户端与 Redis，最后 dispose engine**（它们还在用这个 engine 落库）。
3. 启动期**不做任何业务表 provisioning**；表结构只经人工 `make db-upgrade` 演进。

## 5. 配置系统

**一条线切开：YAML 管形状，环境变量管值。**

- `server/configs/config.yaml` 说「装什么、什么形状」——声明哪些模型、哪些节奏、哪些名字。它进仓。经 pydantic-settings `YamlConfigSettingsSource` 加载，全部模型 frozen + `extra="forbid"`。
- 环境变量说「连到哪儿、用什么凭证」——地址与密钥。**它不进仓**，也因此仓里查不到我们在调谁的哪个接口。

env 的读取交给 pydantic-settings：`config/models.py` 里那几个 `*Env` 类每个字段用 `validation_alias` 写死它对应的变量名，所以**那几个类就是这个服务的环境变量清单**。缺了哪几个它一次全报出来，报的是变量名本身。变量名一律不带品牌/公司前缀。

| 环境变量 | 什么时候必需 |
|---------|------------|
| `DATABASE_URL`（必须 `postgresql+asyncpg://`）、`AUTH_SECRET`（≥32 字符） | 总是 |
| `SSO_BASE_URL` | **它就是 SSO 的开关**：为空即整项关闭（`/auth/sso/*` 不挂载） |
| `SSO_REDIRECT_URL` | SSO 开启时必需 |
| `PMS_BASE_URL`、`ROOT_EMAIL` | 可选：分别开启 PMS 资料同步、root 引导 |
| `REDIS_URL` | 声明了 `redis` 段时必需 |
| `VIDEO_SUBMIT_URL` | **它就是媒体生成的开关**：为空即整项关闭（`/generations` 不挂载、后台不跑） |
| `VIDEO_STATUS_BASE_URL`、`VIDEO_API_KEY`、`IMAGE_TEXT_TO_IMAGE_URL`、`IMAGE_EDIT_URL`、`OSS_BUCKET`、`OSS_ENDPOINT`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_PUBLIC_URL_BASE` | 媒体生成开启时全部必需（半开着比关着更糟） |
| `VIDEO_UNDERSTANDING_URL` | **它就是镜头素材能力的开关**：为空即整项关闭（`shot_video` 不登记进名字表） |
| `VIDEO_UNDERSTANDING_API_KEY` | 镜头素材能力开启时必需；且此时媒体生成必须也开着（出图与对象存储都走它），否则启动报错 |
| `PRODUCT_CATALOG_DATABASE_URL` | **它就是产品资料查询的开关**：为空即整项关闭（`/products` 不挂载）|
| `PRODUCT_IMAGE_BASE_URL` | 产品资料查询开启时必需：产品图所在公开桶的地址前缀（半开着比关着更糟——查得到款却给不出图）|
| `INSPIRATION_DATABASE_URL` | **它就是爆款视频查询的开关**：为空即整项关闭（`/inspirations/*` 不挂载）。视频地址在库里就是完整的，不用另配前缀 |
| `CONFIG_FILE`、`AGENTS_FILE` | 可选：两份声明文件的路径，缺省 `configs/config.yaml` / `agents/agents.yaml` |

**空串与只有空白等于没设。** 那种半配置最难查，所以在类型上就拒掉（`min_length=1` + 先 strip）。

| YAML Section | 内容（只有形状，没有地址与凭证） |
|---------|------|
| `app` | 服务名 |
| `db` | `schema`（默认 `iclip`） |
| `security` | cookie 名（`iclip_session`）/secure/有效期、`cors_allow_origins`（禁 `"*"`） |
| `sso` | `app_name`：我们在对方那边注册的应用名 |
| `redis` | 运行事件流的调参：`replay_window_seconds`、`max_frames`、`max_connections`（声明了 agent 即必填，缺段启动报错） |
| `media_generation` | `video`（`model` / `user_name`）、`image`（`user_name`）、`poll_interval_seconds`、`job_timeout_seconds`。并发、错误重试间隔、关停宽限、心跳这些是实现细节，默认值在 `GenerationQueueSettings` 里，不进 YAML |
| `shot_video` | 镜头素材能力：`understanding_model`（拆解视频用对方哪个模型）、出图的等待与重试节奏（`poll_interval_seconds` / `dev_attempts` / `pro_attempts` / `backoff_seconds` / `backoff_factor` / `job_timeout_seconds`） |
| `models` | 命名模型表：键名即模型名，值为 `provider` / `api`（`chat`\|`responses`，默认 chat）/ `api_key_env` / `base_url?` / `model?`（只在键名不是模型名时写） |
| `ops` | `log_level` |

`models.*.api_key_env` 是 YAML 里**唯一**还留着变量名的地方：每个模型各自一把 key，用哪个变量取是这条声明的一部分，没法用一套写死的别名表达。

另一份声明文件 `server/agents/agents.yaml`（路径由 `--agents` / `AGENTS_FILE` 给出）与 `config.yaml` 分工：那一份是运维配置，这一份是 agent 装配声明——启用哪些 agent、各自用哪份官方 spec、谁带谁。同样 frozen + `extra="forbid"`。**「没有 agent」由文件内容表达（`agent: {}`），不由文件缺席表达**——声明文件必须存在，否则报错。

```yaml
agent:                                 # 键名即 agent id
  storyboard:
    spec: storyboard/agent.yaml        # 相对本文件目录；同目录 instructions.md 自动并入
    model: qwen3.8-max                 # 引用 config.yaml models 段的键名，必填
    skills: [storyboard-workflow]      # 从同级 skills/ 库里挑，不写即不挂
    capabilities: [workspace, shot_video]  # capability 名（登记在 app/capability_table.py），不写即不挂
  producer:
    spec: producer/agent.yaml
    model: qwen3.8-max
    subagent:                          # 有此段即主从，无此段即单 agent
      - spec: shot-writer/agent.yaml
        skills: [storyboard-workflow]  # 下属各挂各的，不继承主 agent
        timeout_seconds: 180           # 本段三个字段名与 harness SubAgent 一致
        max_calls: 3
        on_failure: 就此收手
```

**模型由声明决定，不由 spec 决定**：`agents.yaml` 的 `model` 字段引用 `config.yaml` 的命名模型，spec 里的 `model:` 一律被覆盖（模型连着端点与密钥，属于运维决策）。引用了未声明的名字即装配期报错。spec 文件允许为空——模型在 `agents.yaml`、提示词在 `instructions.md`，spec 可以没内容可写。

**每个 agent（含子代理）装配时都挂官方 `StepPersistence`**，store 为 `PgStepStore`（见 §7）。组合根传入的 `step_store` 是必填参数、无内存兜底默认值——装配一个不落库的注册表在类型上就写不出来。子代理的 `parent_run_id` 由 harness 的 contextvar 自动推断，不需要手工穿线。

### 能力挂载（skill 与 capability）

**挂什么能力由声明决定，一个 agent 只拥有声明给它的那几样。** 两类材料分开走：

- **skill** 是模型面文本资产（流程知识、判断标准、产出格式），放 `server/agents/skills/<skill 名>/`（`SKILL.md` + 可选 `references/`）。库路径在加载声明时解析成绝对路径，不留给官方 `Skills` 按进程工作目录去猜——同一份代码在不同工作目录下行为不同且不报错，是最难查的那类问题。挑了库里没有的名字即装配期报错。
- **capability** 是一组类型化工具（外加可选的指令与钩子），实现在 `capabilities/`，名字登记在 `app/capability_table.py`（与 `models` 段同一个套路：声明面只出现名字，实现由代码持有）。名字没登记即装配期报错；一个名字要求同挂另一个（表里的 `REQUIRES`，如 `shot_video` 要求 `workspace`）而声明里少了，同样装配期报错。

  官方 agent spec（每个 agent 目录下的 `agent.yaml`）自己也有 `capabilities:` 段，而装配走的正是 `Agent.from_spec`，所以**那条路现在是通的**：能声明 14 个 pydantic_ai 内置能力（`WebSearch`/`MCP`/`Thinking`/`ToolSearch`/`Instrumentation` 等）。harness 的能力（含 `Memory`）不在默认注册表里，要写进 spec 得给 `from_spec` 传 `custom_capability_types`。两条路的分工：**spec 那条只传得进 YAML 能序列化的值**，所以需要运行期对象（连接池、domain 服务）的能力走 `agents.yaml` 的名字表。官方自己也止步于此——它的 `Memory` 在 spec 里只给内存/文件/sqlite 三种后端，明明有 Postgres 的实现却不给选。

**工作区（`capabilities: [workspace]`）** 给 agent 一张属于当前这段对话的文本工作台：六件工具（`read_file` / `write_file` / `edit_file` / `delete_file` / `list_files` / `search_files`），落在 Postgres 而不是本地目录——多进程部署下本地目录只有写它的那个进程看得见。几个决定与它们的理由：

- **一段对话一个工作区，主 agent 与它的下属共用**（`scope.py`）。命名空间是 `{user_id}/{conversation_id}`：外层可信（从凭证解析），内层是客户端在请求体里给的（AG-UI 的 `threadId`），所以对话 id 只能当次级隔离段——伪造它最多碰到自己的另一段对话。对话 id 搭 `deps`（`AgentRunDeps`）的车走，**不是**读运行自己的 `ctx.conversation_id`：派活是另起一次运行，官方转发 deps 但不转发 `conversation_id`（下属会拿到一个新生成的 id），读它的话下属写的稿子主 agent 就看不见、而且不报错。算不出命名空间就让这次运行失败，绝不退回公共命名空间。
- **改一段用精确字符串匹配，不用行号。** 行号是某一个版本的文件的坐标，过期的行号区间会静默替换掉错误的行；精确匹配过期时的失败模式是响亮的「零次/多次匹配」。`edit_file` 内部带版本号写回（读—改—写受并发保护），版本号不进工具参数。
- **容量上限在存储层强制，且每次变更先拿命名空间的 advisory 锁。** 命名空间总量是跨行聚合，单条语句的原子性保护不了它。拿到锁之后判断放在 Python 里，「容量满」和「版本冲突」因此是两种可分辨的错误——塞进 `ON CONFLICT ... WHERE` 的守卫只能返回 0 行，而这两件事给模型的提示完全相反。
- 只放文本；二进制走已有的内容寻址媒体（`media` 表 + `media+sha256://`）。

**镜头素材（`capabilities: [shot_video]`）** 给 agent 四件围着一条产线的工具：`video_parser_md`（拆参考片，文档写进工作区）→ `plan_shot_frames`（整片按秒抽帧，按结构层级拼成带帧号的预览板）→ `generate_shot_frames`（按选中的帧号出一张 2×2 网格图并切成 4 帧）→ `ReadMediaFile`（把一张图附进上下文给模型看）。它建立在媒体生成之上——出图走 generation 域的服务，帧与切格产物落生成用的那个公开对象存储——所以两项要么一起开、要么一起关，开关是 `VIDEO_UNDERSTANDING_URL`。几个决定与它们的理由：

- **接力靠工作区里的两份文件，而能力包不认识工作区能力。** 拆解文档（`video/<名>.md`）与取帧账本（`frames/extraction.json`）都要让模型用 `read_file` / `edit_file` 看得见、改得动——时间码写坏了它自己就能改完重来，这也是取帧那条错误提示能给出可执行修法的前提。做法是两件能力都在构造器里收同一个 `FileSpace`——平台层把「存储 + 从本次运行算命名空间的规则」这两样焊成一件，组合根（`capability_table.py`）造一个递给两边，所以配错在结构上不可能，两边写读的必然是同一批文件。命名空间的规范化（挡住 `..` 与空段，隔离根不能是纸做的）也收在 `FileSpace.resolve()` 里，调用方走的是同一条路而不是各自记得做。`shot_video` 不 import `workspace/` 里的任何东西，也不在工具里去 `ctx.capabilities` 认领兄弟能力——那会把兄弟的内部形状写进自己的协议里。少挂一个的失效是静默的（文档照写照读，只是模型看不见），所以 `REQUIRES` 让「挂了 `shot_video` 没挂 `workspace`」在装配期就报错，错误消息指向 `agents.yaml`。
- **能力包不注入指令**（`get_instructions()` 返回 `None`）。四件工具怎么接力是流程知识，归 skill；工具 docstring 只回答「这个工具是什么」。这条界线见 [tool-design.md](tool-design.md) §0。
- **地址只收这段对话里出现过的**（`harness/materials.py`）。模型传进来的地址只有两个来源：从上下文里抄的，或者自己编的——收到的都是同一个字符串，`http://` 前缀判不出区别。`run_materials(ctx.messages)` 把**模型请求那一侧**（用户消息、工具结果、agent 指令）的文本连成一段，校验就两条：这个地址在里面逐字出现过吗；被 tag 声明过种类的，种类对得上吗。响应侧一律不算——模型在正文里写一个地址、或拿它调一次工具，都不该让它自己给自己发通行证；厂商内建工具（联网搜索那类）的返回也在响应侧，一并挡住：让外部网页内容指挥我们的服务器去取素材比模型自己编还危险。`RetryPromptPart` 同样不算，而且报错**不回显被拒的地址**——回显一次，模型重试时它就成了「出现过」的东西。**种类只在声明过时查**：那个信息只有用户附件带得来（`MediaCodec` 把附件换成 `<video url="…">`），本能力产出的预览板与镜头帧是 JSON 字段里的裸串，对它们查种类等于把自己的产物拒在门外。这是**来源约束不是安全边界**——工作区是模型可写的，写个地址进去再 `read_file` 读回来就绕过了；防 SSRF 得在出网取素材那一层单独做。判定用子串包含而不是把地址正则抽出来：工具返回是 dict 就会被序列化成 JSON（里面的 tag 因此带转义引号、扫不出种类，地址本身仍在），是字符串则原样留着（`read_file` 读回账本因此连种类一起认得回来）。
- **视频拆解不走命名模型表，也不做成 agent。** pydantic-ai 的 OpenAI 适配器（Chat Completions 与 Responses 两条都是）对视频输入直接抛 `NotImplementedError`，只有 Google / Anthropic 那几个专属模型类支持视频；而本仓的模型全是 OpenAI 兼容的。所以 `parser.py` 自己说一次 Responses 协议，形状与两家生成 provider 一致（地址与凭证来自环境变量）。它也不是 agent：这次调用没有工具、没有多轮，做成 agent 只会凭空多一层运行血缘，而且派活那条路只递得进文本（`delegate_task(agent_name, task: str)`），视频根本传不下去。**提示词写死在 `parser.py` 里**——它和输出结构是一体的（第 2 节定义几个结构节点、第 4 节就得有几行），拆开放会让改它的人看不见这层绑定。
- **出图的重试与升级归工具，不归 provider。** 不变量 9 管的是模型调用接口那一层：`nano_banana.py` 至今一次调用就是一次调用，不重试也不换渠道。工具是它的**调用方**，和人点两次按钮是同一个身份——所以先在 dev 试、试不通再升 pro 这件事发生在工具里，**每次尝试各落一行 `generation_jobs`**，渠道记在行上，账面上看得见试了几次、各花在哪。**判据只有一条：这次失败有没有可能已经计费。** 只有 `PROVIDER_UNREACHABLE`（连都没连上）和 `PROVIDER_SERVER_ERROR`（对方 5xx 且没有产出）会自动再发；`PROVIDER_RESULT_UNKNOWN`（送出去了但结果不明）、`PROVIDER_REJECTED`（对方明确拒绝）、`OUTPUT_*`（图生成好了只是没转存成功）一律停手并把错误码原样报出来。升级只在失败时发生——「出了图但不够好」是一次新的需求，不是重试。
- **切格按图上真实的分隔带走，检测不到时退回等分并说出来。** 生成的拼图常带外边框和不等宽的格间距，机械等分会让每格带一条白边或错半格。检测在降采样到 640 宽的灰度图上做（分隔带是大尺度结构，成本因此低两个数量级），裁剪回到原图坐标，四格一次 `filter_complex` 裁完（每格起一个 ffmpeg 会把整张 4K 图解码四遍）。整图固定按 `4k` 出：切成四格后每格只剩四分之一线性分辨率，低档不够交付。**退回等分不是静默的**：结果里明说这一格是量出来的还是猜的——等分切出来的图长得和正常结果一模一样，不说就没人知道。
- **像素存一份大的、看一份小的。** 帧与切格产物按内容哈希落公开对象存储（它们要当参考图交给生成接口，对方是自己去下载那个地址的；内容寻址顺带保证同一帧不会在桶里堆重复），预览板与切出来的帧则由 `ReadMediaFile` 按需读进上下文——附的是地址而不是字节，缩到长边 1024 靠对象存储的缩放参数，服务端既不下载也不转码——整片按秒抽出来的候选帧可能上百张，一次全附进去既贵又没法逐张判断。
- **ffmpeg 一律异步起进程、每个都有超时。** 同步的 `subprocess.run` 会把整个 worker 的事件循环按住几十秒——被拖住的不只是这次运行，是这个进程上所有正在读事件流的人。装配时检查 PATH 上有没有 ffmpeg/ffprobe，没有就启动报错，不等模型撞上去。

**挂 skill 库就一定同时挂 `get_skill_reference` 工具**（`harness/skills.py`）。官方 `Skills` 只读 `SKILL.md`，不碰 `references/`；库里放着分支规则而没有读它的手段，模型会照着正文的指示去读、然后无从下手——这种静默失效比报错更难查。工具的访问边界与挂载范围严格一致：没挂给这个 agent 的 skill，它的 references 也读不到（官方文档明说 `include`/`exclude` 不是访问边界，所以边界只能落在工具里）。越界、非 `.md`、不存在都回可重试提示并报出有哪些文件；自家资产编码坏了则直接失败（重试改不了坏文件）。

**下属只拥有显式给它的能力**：子 agent 的 `skills`/`capabilities` 独立声明，不继承主 agent。这条路官方已堵死——capability 挂上去的 toolset 绑在注册它的那次运行上，派活是另起一次运行，结构上就不转发。真正要守的是 `shared_capabilities` 保持空着（它是「给每个下属统一追加能力」的口子，一开就绕过声明）；`inherit_tools` 只影响直接注册在 `Agent(toolsets=[...])` 上的工具，本仓的工具一律经 capability 挂载，因此别把工具直接注册到 agent 上。

### 运行依赖（工具怎么拿到调用方身份）

**一次运行的 deps 就是发起它的 `Principal`**，经官方的依赖注入机制传入：HTTP 端点把中间件建立的主体交给运行入口 → `AgentRuns.open(deps=…)` → `registry.start(…, deps)` → 官方 `run_stream(deps=…)`。业务工具按 `RunContext[Principal]` 写，子 agent 由官方自动转发（`deps=ctx.deps`），无需穿线。

harness 一侧这个参数的类型是 `object` 且全程不解包——那一环不认识业务身份，围栏因此是结构性满足的，不靠自觉。唯一写具体类型的地方是 `domains/agents/api.py` 的 `AgentRuns` 协议。`owner` 保持独立参数：它只是流名字的归属段。

**deps 只放身份，不放 I/O 句柄。** 官方文档的例子把 http client / db session 放进 deps，因为那些例子没有组合根；本仓有，服务经 `app/capability_table.py` 的闭包在装配期注入。更硬的理由是 `Agent[DepsT]` 整体参数化——同一个 agent 上所有能力共享同一个 deps 类型，把服务塞进去，它就会变成每落地一件能力就加一个字段、每件都耦合全体的共享契约。而且运行不绑 HTTP 请求，请求作用域的 session 放进 deps 就是悬空引用。**还有一条最硬的：deps 会原样转发给下属**（对话 id 搭的正是这趟车），所以放进去的句柄是**环境权限**——每个下属的每件工具都拿得到，不管它挂没挂对应的能力。「挂了才有权限」因此只能靠构造器注入，靠 deps 就是反过来的。

deps 里放的是 `AgentRunDeps`（可信主体 + 所属对话）。加上「对话」是因为它同样是**每次运行**的事实，而且派活时官方转发 deps、不转发运行自己的 `conversation_id`，所以要让下属知道自己在哪段对话里，只有这一条路。

**造 deps 的那个回调同时是会话的关卡**：它拿到协议解析出的两个 id（会话与运行），核对这段对话是不是调用者的、是不是这个 agent 的，并把这次运行记在对话上（`last_run_id`）。位置是被逼出来的——必须发生在开流之前，一旦开始发事件，再想报 404 就只能在流中途爆开。它因此是个可等待的调用（要读库）。重连时这个回调会再走一遍（运行 id 抢不到生产权，但请求体照样被解析），所以核对必须可以重复做，而它本来就是：记的是「最近一次运行是谁」，重复写同一个值没有影响。

三条不能破的规矩：

- **不给 deps 实现 `StateHandler`。** 官方 adapter 会把客户端提交的 `state` 写进实现了该协议的 deps；那等于让客户端往可信身份对象里塞东西。`Principal` 是普通 frozen dataclass，客户端发来的 state 被忽略并留一条 warning——这是正确的信任姿态，不是缺陷（本系统不消费 AG-UI state）。
- **身份是每次运行传入的，不是装配期挂上的。** 注册表启动期冻结、跨运行共享；把身份挂上去就串人。
- **捕获即冻结**：主体在发起时抓一次，跑到一半吊销 key 不会中断这次运行（运行不由请求持有的自然推论）。将来的续跑路径没有 HTTP 请求，deps 要从库里的归属事实重建。

注：`deps_type` 官方只用于静态类型、运行期不做校验，本仓的 agent 是 `Agent[Any, Any]`，所以「工具声明的 deps 类型与实际传入不一致」不由类型检查拦住，而由 `T-DEPS-01/02` 两条测试守。

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
| `conversations` | 一段对话（会话） | `owner_user_id` FK 级联删除、`agent_id`（agent 在配置里声明，库里没有对应的行，故无外键）、`title`、`last_run_id`（客户端为最近一次运行铸造的 id）、`created_at`/`updated_at`；索引 `(owner_user_id, updated_at DESC)` 支撑「我的对话，最近的排前面」；见 §12 |
| `tasks` | 一张创作需求单 | `creator_user_id` FK **restrict 不级联**（下发过的需求单是公司账本上的事实，不跟着账号消失）、`status` + CHECK（四个值）、`deadline` + CHECK（非草稿必须有）、`brief` JSONB + CHECK（必须是 object）、`priority`；索引 `(updated_at DESC)` 支撑「最近改动的排前面」；见 §13 |
| `generation_jobs` | 一次媒体生成的事实（**不含排期**） | `owner_user_id` FK 级联删除、`api_key_id` **故意不建外键**（审计事实要活得比那把 key 久）、`request` JSONB、`status`、`provider_task_id`/`provider_status`/`provider_snapshot`、`output_url`、`error_code`/`error_message`、四个时刻；见 §11 |
| `public.procrastinate_*`（4 张） | 生成任务的**排期机械**，不是事实 | procrastinate 3.9.0 自带的 DDL，原文冻在迁移 0005 里。落在 `public` 而不是 `iclip`：它的 SQL 全是不带 schema 的裸名字，塞进 `iclip` 要给它的连接一直配对的 `search_path`，多一处必须两边一致的配置。**升级它的做法是把它新增的迁移脚本抄成一个新 revision**，不是改 0005 |

| 表（schema=agent_runtime） | 用途 | 关键点 |
|----|------|--------|
| `runs` | Agent 运行血缘（run_id / conversation_id / parent_run_id） | 结构严格镜像官方 pydantic_ai_harness StepPersistence 存储形状（本仓决策：只换数据库实现，不改表结构） |
| `events` | append-only 逐步事件 | 同上；`(run_id, seq)` 索引 |
| `snapshots` | 可续跑的消息历史快照 | 同上；`state ∈ {complete, interrupted}`；`messages` 存 JSON 文本（text，非 jsonb） |
| `tool_effects` | 工具副作用账 | 同上；PK `(run_id, tool_call_id)` upsert |
| `media` | 内容寻址媒体（sha256 主键） | 同上；≥64KiB 负载自快照外置 |
| `workspace_files` | agent 工作区的文本文件 | 本仓自有（非官方表）；PK `(namespace, path)`；`size_bytes` 是生成列 `octet_length(content)`；见 §5 |

写入方：`harness/step_store_pg.py`（实现官方异步 `StepStore` / `MediaStore` 协议，挂到 `Agent(capabilities=[StepPersistence(...)])`）；DDL 由 Alembic 0002 拥有，store 不自建表。

唯一 provisioning 路径：人工 `make db-upgrade`（`alembic upgrade head`，所有环境一致）；迁移契约测试用 scratch 环境验证 head 与 ORM 元数据零漂移。该断言覆盖 `iclip` schema 下的**全部**表，因此每个在这个 schema 里有表的模块都要把自己的元数据加进测试的 `_MODULE_METADATA`（少加一行，那张表的漂移就无人看守）；`agent_runtime` 那几张表另挂独立元数据，不在断言范围内——所以往那个 schema 加表时，迁移要人工 `make db-upgrade` 确认一次。

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
| `POST /generations` | `generation:submit` | 受理一次生成：校验 + 落一行 `pending`，返回 202 与它的 id。**这一步不碰 provider**（图像接口一次要等几分钟，留在请求里客户端会先超时）|
| `GET /generations`、`GET /generations/{id}` | `generation:read` | 列表（`limit` ≤ 100）与查单个。别人的一律 404；`users:manage` 看全部。响应不含 provider 原始快照与排队机制字段 |
| `GET /products/{styleNo}` | `assets:read` | 按 PDM 款号查一个款：品牌、品类、颜色、产品图。零副作用；查不到 404。没配目录库时整组不挂载。见 §13 |
| `POST /inspirations/videos/search` | `assets:read` | 按 **WMS 编号**搜这些款的爆款视频，服务端按指定维度取 top-N。零副作用；没配爆款库时整组不挂载。见 §14 |
| `POST /conversations` | `agent:run` | 开一段对话；id 由服务端生成，客户端拿它当 `threadId` |
| `GET /conversations` | `agent:read` | 我的对话，最近活动的排前面（`limit` ≤ 100）。别人的看不见，治理者也没有看别人的口子 |
| `PATCH /conversations/{id}`、`DELETE /conversations/{id}` | `agent:run` | 改名 / 删除；删除连带清掉这段对话的工作区文件。别人的一律 404 |
| `GET /tasks` | `tasks:read` | 需求单列表，最近改动的排前面（`limit` ≤ 100，可加 `status=` 筛一档）。**人人看得见全部**——它是工作队列，不是私人资源 |
| `GET /tasks/{id}` | `tasks:read` | 查一张。不存在才 404 |
| `POST /tasks` | `tasks:write` | 提一张需求单，落地即草稿。创建者取自主体，请求体里给一律 422 |
| `PUT /tasks/{id}` | `tasks:write` | 整体覆盖。草稿只有创建者或治理者能改（否则 403）；下发之后谁都能改，但只剩管理信息与那几项补充字段，动了冻结的创作输入 409 |
| `POST /tasks/{id}/publish` | `tasks:write` | 下发。仅草稿，仅创建者或治理者；要有期限且期限未到（比较在数据库里做），brief 要说清做什么，否则 422/409 |
| `POST /tasks/{id}/confirm` | `tasks:write` | 接单。仅已下发；接单不挑人 |
| `POST /tasks/{id}/withdraw` | `tasks:write` | 撤回。仅已下发或已接单；终态，回不去 |
| `DELETE /tasks/{id}` | `tasks:write` | 删草稿，仅创建者或治理者。下发之后删不掉（409），要停就撤回 |
| `POST /agents/{agent_id}/chat` | `agent:run` | 发起一次运行并订阅它的事件（`text/event-stream`，请求体为官方 `RunAgentInput`）。强制 `Content-Type: application/json`，否则 415；未注册 id 404；请求体形状不合法 422；**`threadId` 不是自己名下、且属于这个 agent 的对话 → 404**（核对发生在开流之前）；同一个运行 id 再来一次是接着读，不重复跑 |
| `GET /agents/{agent_id}/chat/{conversation_id}/{run_id}` | `agent:run` | 接着读同一次运行的事件。位置取 `Last-Event-ID` 头，其次 `?from=`，都没有就整段重放；已经读到末尾就直接收流。没有这次运行 404，过了重放窗口 409，两个 id 或位置形状不合法 422。别人的运行一律 404（流名字里带归属）|
| `OPTIONS /agents/{agent_id}/chat` | 公开 | 204 且**刻意不带任何 `Access-Control-Allow-*` 头**：与上面的 content-type 要求组成一对 CSRF 防线（免检 content-type 都能塞 JSON 且不触发预检，故要求非免检类型来强制预检，再在此拒掉） |

## 9. 运维

- `scripts/admin.py`：`set-roles <username> <role1,role2>`、`list-users`、`issue-key`——直连 DB 绕过 API，专为非 SSO 场景的 root 引导设计（SSO 场景用 `ROOT_EMAIL`）。
- 日志：structlog（结构化，级别来自 `ops.log_level`）。观测尚未接入。
- 测试门禁与命令：见 [test-design.md](test-design.md) 与 [../AGENTS.md](../AGENTS.md)。

## 10. 运行事件流

一次 agent 运行分成两半：**跑**和**读**。跑的那一半是个后台任务，不绑在任何一次 HTTP 请求上；读的那一半就是订阅，来了又走都不影响跑的人。中间只有 Redis 里的一条流。决策与权衡见 [adr/0003](adr/0003-detached-runs-and-replayable-streams.md)。

```text
POST /agents/{id}/chat            GET /agents/{id}/chat/{会话 id}/{运行 id}
  │ 抢到生产权就起后台任务            │ Last-Event-ID: 1787543423217-0
  │ 抢不到说明已经有人在跑            │
  ▼                                ▼
后台任务：AG-UI 事件 → 编码 → 写流   从给定位置往后读，读到终帧为止
  │ 另有心跳任务定期续存活标记
  ▼
Postgres（StepPersistence 照旧落库）
```

| Redis 键 | 放什么 |
|---|---|
| `iclip:agent:run:{用户 id}:{会话 id}:{agent id}:{运行 id}` | 事件流本体，一帧一条；最后一帧带「结束了」的标记位。名字里有会话那一段，所以同一个人在两段对话里复用同一个运行 id 也不会串到一条流上 |
| 同名 + `:state` | 这条流处在哪个阶段：`live`（有人在写，心跳续期）/ `done`（写完了，与流同寿命）/ 键不存在（什么都没有） |

几条不能改的规矩：

- **三个阶段各对应一种处置**，`done` 与「键不存在」不能合并成一个「没人在写」：前者说明读者只是读到了末尾（就此收流，不造事件），后者才是写的人没留下结局就消失了（写一帧可重试的中断收尾）。`done` 标记同时挡住第二个生产者——不然重放窗口内同一个运行 id 再来一次会重跑一遍，而重复的帧全落在终帧之后，读的人看不见，白烧的是模型调用。
- **终帧靠流上的标记位判断**，不去解析帧内容——存进流的帧对读的人是不透明的一段文本。读到第一个带标记的帧就停，后面的一律不看（这条顺带化解了「生产者和收尾的人各写了一帧终帧」的竞争：谁先写谁算）。
- **心跳是独立任务**，不搭在写帧上。模型一次调用几十秒不出事件是常态，把续期挂在写帧的节奏上会把活着的运行判成死的。
- **活跃运行的流不裁剪**，只在运行结束时给整条流定重放窗口。裁了中间段，带位置来续读的人会拿到一个有空洞的流而不知情。
- **收尾也要定重放窗口**，不管收尾的是写的人还是读的人。漏了后者的话，进程每崩一次就在 Redis 里留下一条永不过期的流。
- **读事件会挂在 Redis 上等**，一等就是一个阻塞窗口那么久，期间占住一条连接。所以 `max_connections` 是「同时能有多少人在看事件流」的天花板；建客户端时 socket 超时也必须比这个等待窗口宽出一截，否则客户端会先把自己判超时。连接池用「满了排队」而不是「满了报错」：报错砸中的可能是后台运行的心跳，那会让看的人多把跑的人弄死。

## 11. 媒体生成

一次生成是一行持久事实，从受理到出结果全程在 `iclip.generation_jobs` 里推进。HTTP 只负责受理与查询；真的去调外部接口是后台的事。决定与权衡见 [adr/0004](adr/0004-generation-queue-in-postgres.md)。

```text
POST /generations                     procrastinate（三条队列，各自一个 worker）
  │ 校验 + 落 pending                   │
  │ + defer 提交任务，202               ├─ generation-submit-image ┐
  ▼                                    ├─ generation-submit-video ┘ 标 submitting → 调 provider
iclip.generation_jobs ◀────────────────┤      重跑时看见 submitting → 判失败（不重投）
  （一次生成的事实，不含排期）             ├─ generation-poll：查一次状态
                                       │      还在跑 → 抛 StillRunning，5 秒后重来
                                       │      成了 / 废了 → 终态
                                       └─ 每分钟：把失联 worker 手上的任务捡回来
```

**排期归 procrastinate，事实归我们。** 「谁该跑、几点跑、几个同时跑、进程死了谁发现」在它的表里（`public.procrastinate_*`，见 §7）；`iclip.generation_jobs` 只回答「这次生成是谁发起的、发给了谁、到哪一步了、结果是什么」。清空它的表只丢排期，不丢任何一次生成的事实——所以不变量 1 仍然成立。

几条不能改的规矩：

- **同一件事只在一处记。** 排期字段（试了几次、下次几点、谁在处理）已经从 `generation_jobs` 上删掉了（迁移 0006）。两处各存一份必然分叉，而分叉的那一刻没人知道该信谁。
- **三条队列切开，是因为耗时差着数量级**（图片提交 300 秒 / 视频提交 30 秒 / 查状态 1 秒）。混在一条里，一批图片会把视频按在后面等。每条一个 worker，并发各 100。
- **并发按「纯等待」定（各 100）。** 一次提交或查询几乎整段时间都挂在对方的 socket 上，CPU 是空的。这不需要加大数据库连接池：连接只在状态跳转那几毫秒里开合，**从不跨着那次 HTTP 调用握着**。真正的天花板在别处——图像结果转存走 `oss2` 这个同步 SDK，包在 `asyncio.to_thread` 里，受默认线程池（约 `CPU+4`）限制；上传要是成为瓶颈，那是要显式配一个执行器，不是调这里的并发。
- **「还在跑」借重试通道走，但它不是失败。** 任务抛 `StillRunning`，由我们自己的重试策略决定隔多久再来。**不是每次 defer 一个新任务**——那样一个生成一小时能往它的表里写七百多行；借重试通道的话，一个生成始终只占一行。
- **「还在跑」按固定间隔再问，不做逐次拉长的退避。** 退避省下的是几次廉价的状态查询，代价却是「做完了却没人发现」的延迟越拖越久，而且拖得最狠的正是跑得最久的那些任务（那时已经退到上限）。用户盯着进度条等的就是这个延迟。**只有「问不通」才隔得更久**（对方躺下时几百个在飞的任务每 5 秒重试一次只会让它更起不来）。真撞上限流再谈退避，那时该由它明确告诉我们，不由我们先猜。
- **重试策略不许设次数上限。** 界在任务体的第一句话，不在计数器：轮询撞上总时限就写终态并正常返回，提交重读那行看见 `submitting` 就判失败并正常返回——**上限是守卫给的，所以每个任务最多多跑一次就自己停了**。反过来在策略上设了上限，次数用完的任务会落在终态上，而它对应的那一行还停在 `submitting`：一次可能已经付过钱的生成，永远没有结论，也没人知道。
- **卡在 `submitting` 上的行一律判失败，绝不自动重投。** 两家接口都没有幂等键，重投一次就是重复付一次钱。「不知道上次发出去没有」的正确处置是把事实照实记下来让人决定，不替他猜。同理，提交阶段的失败一概是终态，连网络超时也不重试。**这次收尾的写入带状态守卫**（只在这行还停在 `submitting` 时才落）：判断和写入之间隔着一次 await，那当口原来那个进程可能刚把真结果写完——谁有真结果谁说话，绝不把一次已经付过钱的成功盖成失败。**整套「重跑是安全的」就靠这个守卫**，不靠「不会重跑」。
- **进程死掉之后任务怎么回来，分两种，别只想着一种。** 优雅关停（发版）打断在飞的任务时，任务是抛异常结束的，重试策略把它重排回待办——这一半不用管。**硬杀**（SIGKILL、OOM、机器没了）那一半必须自己捡：procrastinate 自动维护 worker 心跳，但**不会**自动重跑失联 worker 手上的任务（`get_stalled_jobs` 只是个查询，`retry_job` 要自己调）。所以有一个每分钟跑一次的周期任务干这件事，它**挂在轮询队列上**——周期任务 defer 到没有 worker 消费的队列会永远躺在那儿，而且不报错。
- **心跳判活跟任务多长无关**，所以不需要「按最坏耗时估租约」那一套。一个正在做 300 秒图片提交的活 worker 每 10 秒报一次心跳，永远不会被误判；心跳断 30 秒就认为它没了。
- **落行与排队做不到一个事务里。** 行走 asyncpg、队列走 psycopg（procrastinate 只支持它），两个驱动就是两个事务。排队失败时把那行判失败（`QUEUE_DEFER_FAILED`）并把错误抛给调用方——留一个「永远 pending」的行更糟，那看起来像还在排队。崩在两步中间会留下一个没有任务的 `pending` 行：罕见、看得见、由人重新发起。
- **信号处理器归 uvicorn。** 起 worker 时必须显式关掉 procrastinate 的（它默认装），否则两边都抢 SIGTERM，关停顺序变成谁先注册谁说了算。
- **关停先给宽限期，到了就打断。** 无限等一次十几分钟的图像提交，等于把整个进程的关停拖那么久，而部署环境的关停超时一到照样会杀进程——那时被打断的东西一样多，只是没人记下来。
- **模型与渠道由请求带来，我们不替调用方换。** 视频那家的模型是请求体里的参数（`model`，不给就用配置里的默认模型）；图像那家的模型写死在接口地址里，真正可选的是 `channel`（`dev`/`pro`）。两者取值不同价钱也不同，所以替调用方偷偷换一个等于悄悄改了这次花多少钱——和悄悄重投是同一类毛病。**一次调用，报错就是报错**，不自动重试也不换渠道；错误码只负责让人分清「送到了没有」（`PROVIDER_UNREACHABLE` 可放心重发 / `PROVIDER_RESULT_UNKNOWN` 可能已计费，先核对），不驱动任何自动动作。实际用了哪个模型/渠道记进 `provider_snapshot`——配置里的默认值将来会改，旧行得说得清当时用的是什么。
- **没见过的 provider 状态一律报错**，不当成「还在跑」——那等于对方新加了一个终态而我们一直轮询下去，一个已经结束的任务永远不会收尾。固定间隔没有自我收敛的性质，所以总时限（`job_timeout_seconds`）是必需的兜底，不是可选项：从提交算起超过就判超时。
- **所有时刻都取数据库的时钟**（`now()`），一个都不从应用进程取。多台应用服务器的时钟差几秒，「这次生成花了多久」「谁先写的」就都对不上，而这些是要拿去对账的。
- **图像结果转存成自己的公开对象。** 图像接口返回的是会过期的签名 URL，直接存库过几天就是烂链接；生成一到手就下载转存，`output_url` 存的是不会过期的地址。**视频结果本轮直接存 provider 给的地址**，没有转存。

**同步接口一步落到终态。** 图像那条没有「先提交后轮询」两步，回执和结果一起回来，所以对账 id（`provider_task_id`）与 `submitted_at` 只有在写完成态那一步才有机会落库——错过就永远没人写它们。视频那条 `submitted_at` 早就填过，完成时保持原值，不改成「拿到结果的时刻」。

**请求类型只有一套定义**（`schemas.py` 的 pydantic 模型）：它既是 HTTP 请求体，也是入库形状（`model_dump(by_alias=True)`，camelCase，`kind` 不重复存——那是表上的一列）。读回来按 `kind` 挑 `TypeAdapter` 校验一遍，形状坏了响亮失败。因此「HTTP 进得来的东西」和「从库里读回来的东西」走的是同一条判定路径，不会一边合法一边不合法。响应刻意不含 `provider_snapshot`——里面带着 provider 的签名 URL。

## 12. 对话（会话）

一段对话就是用户在界面上看到的一个聊天窗口，它的 id 就是 AG-UI 的 `threadId`。**id 由服务端发放**（`POST /conversations`），发消息时服务端核对它是不是调用者的；核对失败一律 404。这一条把「会话存在」从「客户端说了算的一个字符串」变成了服务端记录在案的事实，于是列表、改名、删除才成立，工作区的隔离段也不再只靠「反正外层套着用户 id」兜底。

一段对话下有很多次运行，两者的 id 各管各的：

| id | 谁生成 | 用来做什么 |
|---|---|---|
| 会话 id（`threadId`） | 服务端 | 认领这段对话：归档运行、划工作区地盘、算事件流的名字 |
| 运行 id（`runId`） | 客户端 | 认领这一次运行：断线重连、同一个 id 再发一次是接着读而不是重跑 |
| 落库的 `run_id` | 官方 `StepPersistence` | 运行记录的主键（`{agent 名}-{短 uuid}`）；主 agent 与每个下属各一条 |

**运行 id 必须由客户端铸造**，不能改成服务端生成：客户端要在副作用发生**之前**就知道这次运行叫什么，否则连接在响应到达前断掉，那次运行就成了没人认领的孤儿——钱花了，接不回来，重试还会再跑一次。它是幂等键，不是名字。服务端生成的那个 id 走另一条路：客户端给的 `runId` 会被交给引擎盖到这次运行的消息与快照上（`run_stream(run_id=…)`），所以两边虽然不是同一个主键，事后仍能对上。

**运行记录（`agent_runtime.runs`）不加指向 `conversations` 的外键。** 那几张表是官方结构的镜像（只换数据库实现，不改表结构），而且它记的是引擎的运行——一次对话里主 agent 一行、每个下属各一行——跟「用户发的一条消息」不是一回事。两边靠 `conversation_id` 这个字段对上，已经有索引。

**删除对话连带删掉工作区文件，但这条线接在组合根。** 工作区靠拼出来的命名空间 `{用户 id}/{对话 id}` 认领地盘，两张表之间没有外键，所以连带关系只能由代码保证。conversations 只声明一个「删掉这段对话派生出来的东西」的口子（`PurgeDerived`），不知道接上去的是什么；命名空间怎么拼只写在 `capabilities/workspace/scope.py` 一处（两处拼法哪天不一致，就会静默删错地方）。**先删派生的，再删对话行**：两者在不同的连接上凑不成一个事务，顺序是唯一能给的保证——崩在中间留下「派生的没了、对话还在」，再删一次即可；反过来才麻烦，对话行没了那些文件就再没人认领。运行记录不删，那是账本。

## 13. 产品资料查询

一个款号进去，拿到这个款的品牌、品类、颜色和产品图。**只读、零副作用、不建表**——数据在外部一个 Postgres 里，那是 PDM 经 CDC 同步过来的副本，我们只按显式列名读它。

```text
GET /products/{styleNo}
  │  product_number 全库唯一，一查一个准
  ▼
外部目录库（一条 CTE，一次往返）
  ├─ 款：状态、开发年份、品牌码、品类 id、WMS 编号
  ├─ 图：file_mappings → asset_versions → assets（object_key）
  └─ 色：skcs → colors（码、名、色系码、RGB）
  │
  ▼
本仓的三张常量表把码翻成名字 → camelCase 响应
```

几个决定与它们的理由：

- **一次往返，不是三次。** 那个库在网络另一头，三条查询就是三个来回；图和色在库里聚成 JSON 再回来。
- **四条过滤一条都不能省。** 每一跳都要 `is_active AND NOT is_source_deleted`（同步副本用标记位表达删除）；取图那跳还要 `is_current AND status = 'succeeded'`（转存失败的行也在表里，用它会得到一个指向空对象的地址）；图按 `content_hash` 去重（同一个款下确实有多条映射指着同一张图）；颜色走 `style_pdm_id`——`pdm_skcs.style_id` 那个 UUID 外键列上游还没回填、全是 NULL，用它一个颜色都查不到**而且不报错**。
- **码是上游的事实，名字是我们的对照表。** 上游只给裸码（品牌 `"2"`、品类 `52`、色系 `"BL"`），翻译成人话要的那几张表没被同步进来。所以名字冻在 `tables.py` 里（抽自权威源），**查不到就返回 `null`，绝不猜**——空一格看得见，猜错了没人看得见。它们是别人的码表、不是我们的事实，所以当配置放代码里，不进数据库也不进 YAML。
- **图片地址是拼出来的。** 库里只有 object key，桶的公网前缀走环境变量（地址不进仓）。那个桶同时装着别处要用的东西，所以前缀是配置不是常量。
- **`styleWms` 必须出现在响应里。** 它是同一个款在 WMS 那边的编号，和 PDM 款号是两套不通用的编码；调用方拿它去查别的系统。
- **上游改结构我们响亮地失败。** 那几张表不在本仓的迁移里，也没有漂移守卫（`T-MIG` 只管自己的表）；防线是显式列名——列没了就是查询报错，而不是悄悄返回半截数据。
- **连接在会话层设成只读。** 那个库的账号本身有写权限，我们只该读；把只读钉在自己这边，就不依赖对方的授权配置哪天有没有改对。
- **查得到款、图和色为空是正常结果**，不是错误：上游同步不全是常态。

## 14. 创作需求单

一张需求单是「要做什么片子」这件事的持久事实。它和本文其余部分最大的不同是：**它没有属主**。对话是私人的，生成记录是私人的，需求单是**全公司的一张工作队列**——谁有 `tasks:read` 谁就看得见全部，所以这里用不上 `platform/db` 的行级归属原语，「别人的一律 404」那套写法在这个模块里一次都不出现。判断只落在「能不能改」这一侧：看得见但不让改是 403。

状态机四档，走不通的流转一律 409（合同把 409 的释义定成「与资源当前状态冲突」）：

```text
        ╭───────╮  publish   ╭───────────╮  confirm   ╭───────────╮
        │ draft │───────────▶│ published │───────────▶│ confirmed │
        ╰───┬───╯            ╰─────┬─────╯            ╰─────┬─────╯
            │                      │                        │
       delete（仅创建者）           ╰────────┬───────────────╯
            │                               │ withdraw
            ▼                               ▼
         （没了）                      ╭───────────╮
                                      │ withdrawn │ 终态：改不动、删不掉
                                      ╰───────────╯
```

三件事值得单独记：

- **下发即冻结。** `published` 之后，需求方写下的创作输入不许再动；能改的只剩管理信息（标题、优先级、期限）与接单之后才补得出的那五项（时长、画幅、需求描述、参考图、参考视频，登记在 `schemas.PLANNER_FIELDS`）。接单的人是照着那份需求开工的，改了等于让两边看到的需求不一样。PUT 是整体覆盖，所以服务层拿提交上来的 brief 和库里的逐字段比一遍，冻结的那些有一项不同就拒——而不是默默改回去。
- **期限的比较发生在数据库里。** 「发布时期限必须还没到」这句写在 `UPDATE` 的 `WHERE` 里，用的是 `now()`。应用进程的钟快了几秒，同一张需求单就会在这台机器上发得出去、在另一台上发不出去。
- **每个写方法都带状态守卫。** 调用方读到这一行时它是什么状态，就把那个状态交回来当写入条件（`expect=`）。判断和写入之间隔着一次 await，那当口别人可能刚把它撤回；对不上就一行也改不到，服务层把它翻译成 409 并让人重读一次。

brief 只有一套定义（同 §11 的生成请求）：`schemas.TaskBrief` 既是 wire 形状也是入库形状，落库存 camelCase，读回来重新校验一遍，形状坏了响亮失败。

## 15. 爆款视频查询

给一组款，拿回这些款下表现最好的那批短视频：地址、作者、发布日期、五项指标、CT 归属与平台类目。**只读、零副作用、不建表**——数据在外部一个 Postgres 里（数仓的爆款榜 + 视频打标结果）。

```text
POST /inspirations/videos/search  { styleWmsList, sortBy, limit }
  │  按 WMS 编号过滤，在库里按指定维度排序后截断
  ▼
爆款榜（一行一条视频，video_id 是主键）
  └─ LEFT JOIN 打标表：拿转存过的可播地址
```

几个决定与它们的理由：

- **过滤用的是 WMS 编号，不是 PDM 款号。** 这不是选择：全库 287 个款号拿去比对，按 WMS 编号命中 196 个，按 PDM 款号只命中 1 个。传错那一种的失效是静默的（返回空列表），所以字段名里带着 `wms`——让传错的人在名字上先愣一下。产品资料接口响应里的 `styleWms` 就是拿来喂这里的。
- **排序在库里做。** 一次二十个款能命中近千条视频，取的是那个维度上的前 N 条；捞回应用里再排等于换了一批样本。排序维度是封闭枚举，**调用方给的字符串永远只是键**，进 SQL 的是代码里那张表的值。
- **指标原样给，不合成综合分。** 哪个维度算「爆」是调用方的判断。钱走 `Decimal`，不走浮点。
- **不去重。** `video_id` 是那张表的主键，一条视频只有一行；`popular_mon` 是它上榜的月份，不是累积维度。排序尾巴上跟一个 `video_id`，让指标持平时的先后是确定的。
- **可播地址可能没有。** 转存过的副本只有八成，缺的那些照样返回——原始平台地址一直都在。
- **这里的类目和产品资料里的品类不是一套。** 这边是平台口径的英文类目（`Casual Trainers`），那边是 PDM 品类（`高跟鞋 / Pumps`）；两个系统各说各的，中间不存在映射，我们也不翻译。
- **CT 归属这边反而有。** 上游行上就带着 CT 全名；产品资料那边拿不到（见 §13），所以同一个概念在一个接口里有值、在另一个里是 `null`。
