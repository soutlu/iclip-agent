# iclip-agent 架构文档

> 本文管分层与装配。领域语言见 [CONTEXT.md](CONTEXT.md)，测试策略见 [test-design.md](test-design.md)，决策见 [adr/](adr/)。

## 1. 定位与运行拓扑

iclip-agent 是 Productor 视频创作产品的后端，也是跨端合同的定义方：模块化单体，单个代码库（`server/` + `web/`）。**PostgreSQL 数据库是本系统全局唯一的事实源。**

双主体身份体系：Cookie 会话用户 + Bearer API key 机器用户，浏览器经同源 `/api`（反代 rewrite）进来，两者都由 `server/` FastAPI（每 worker 一份）的 PrincipalResolver 解析成唯一信任点。

Agent 引擎是 PydanticAI，隔离在 `harness` 围栏内；agent 的运行历史（run 血缘、逐步事件、可续跑快照、工具副作用）落 Postgres 的 `agent_runtime` schema。模型经 `config.yaml` 的命名表装配，agent 在 `agents.yaml` 里引用名字。

agent 运行不绑在发起它的 HTTP 请求上：运行在后台跑，产出落进进程内的实时状态，HTTP/WS 只订阅（见 §10）。**实时状态是投影，不是事实源**；持久事实只在 Postgres。

## 2. 分层依赖规则

```text
╭──────────────────────── app（组合根，可 import 一切） ───────────────────────╮
│                                                                            │
│   ╭─────────────╮        ╭──────────────╮        ╭────────────────────╮    │
│   │  harness/   │◀───────│ capabilities/ │───────▶│     domains/       │    │
│   │ 通用内核     │        │ capability     │        │ 业务模块            │    │
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

围栏由 tach（`server/tach.toml`）与架构单测（`tests/unit/architecture/` 的 `FRAMEWORK_FENCES`）强制，只走 `server/src/`；新增一个碰 SQL 或框架的文件要在 `FRAMEWORK_FENCES` 加一行。跨模块只准 import 对方 `public.py`。能力包之间互不 import：两件能力要共用的东西下沉到 `platform/` 做成协议，组合根把同一个实例递给两边。接口随首个实现定义，不提前写投机 ABC。

**外部存储落点**：实现官方协议的后端跟着「说这门协议的那一层」走（`harness/step_store_pg.py`、`harness/jobs.py`）；模块或能力包自有的表放自己模块里的 `infra_sql.py`；`platform/` 下的存储只出协议与后端，业务侧只认协议；engine 只在 `app/` 建。

## 3. 目录布局

| 路径 | 职责 |
|------|------|
| `server/src/iclip/main.py` / `asgi.py` | CLI serve 入口 / ASGI 导出入口 |
| `server/src/iclip/app/` | 唯一组合根：装配、entrypoints、lifespan、capability 名字表 |
| `server/src/iclip/config/` | RuntimeConfig：YAML 源（形状）+ `*Env` 类（环境变量清单） |
| `server/src/iclip/domains/<模块>/` | 业务模块，每个是八件固定文件（`models`/`schemas`/`repository`/`infra_sql`/`service`/`api`/`module`/`public`）的组合；清单与各自的边界见 §6、§11–16 |
| `server/src/iclip/harness/` | 通用 agent 内核：模型与 agent 装配、skill 库、prompt 队列的表、官方协议的 PG 后端、媒体引用的文法、对话素材判据、`transcript/`（见 §10） |
| `server/src/iclip/capabilities/` | capability 实现，一件一个子目录 |
| `server/src/iclip/platform/` | 跨模块共用的技术设施：行级归属原语、领域错误 → HTTP 单点映射、对象存储、文件存储、transcript 协议的形状（照抄来的外部合同，谁都不拥有它） |
| `server/src/iclip/common/` | 领域错误分类（`DomainError` 及其子类） |
| `server/configs/config.yaml` | 唯一 Runtime Configuration（只有形状） |
| `server/agents/` | agent 装配声明 `agents.yaml` + 每 agent 一个子目录（官方 spec + 提示词）+ `skills/` 技能库 |
| `server/migrations/versions/` | Alembic 迁移，一个 revision 一个文件 |
| `server/scripts/admin.py` | 引导型管理 CLI（set-roles / list-users / issue-key），直连 DB，用于非 SSO 场景的 root 引导 |
| `web/` | 产品前端；命令与边界见 [../web/AGENTS.md](../web/AGENTS.md) |
| `contract/` | 跨端合同：`openapi.json` 由 `make contract` 从后端导出；`conventions.md` 写合同表达不了的约定 |

## 4. 装配流程

1. `asgi.py` 读 `CONFIG_FILE`（缺省 `configs/config.yaml`）与 `AGENTS_FILE`（缺省 `agents/agents.yaml`）：只做 YAML 加载与结构校验（extra=forbid），不读任何环境变量；agent 声明另把 `spec` 与同级 `skills/` 库解析成绝对路径、找出同级 `instructions.md`，声明文件、spec 文件或目录缺失即报错。
2. 组合根 `app/bootstrap` 按序装配，`resolve_settings()` 把 YAML 的形状与环境变量的值合成运行值，缺哪几个变量一次全报出来：
   - engine（asyncpg，每 worker 一个连接池）→ identity → `SSO_BASE_URL` 非空时装 SSO / PMS 协议客户端。
   - conversations，把它的「删对话时连带清掉派生物」「列 / 读 / 写派生文件」口子接到工作区上，并按路径挂上写入前的校验器。
   - `OSS_BUCKET` 非空时建公开对象存储（素材、生成、镜头帧共用这一只桶）并装 assets 模块，没有桶整组路由不挂。
   - `media_generation` 段 + `VIDEO_SUBMIT_URL` 非空时装 generation 模块：两家 provider 一起装，缺一个 env 即报错，对象存储没开也报错。
   - `VIDEO_UNDERSTANDING_URL` 非空时建镜头素材取素材用的 HTTP 客户端，并检查 PATH 上有 ffmpeg / ffprobe；此时媒体生成必须也开着。
   - `PRODUCT_CATALOG_DATABASE_URL` / `INSPIRATION_DATABASE_URL` 非空时各建一个只读 engine 并装 products / inspirations 模块。
   - tasks 模块，把「按款号抄快照」协议接到产品资料库与桶上；缺一个就接一个只会拒绝的替代品。
   - `build_agent_registry()`：模型、凭证、spec 缺失在此 fail fast，capability 名字表在这一步建起来。
   - 实时状态、prompt 队列与运行驱动，装上 transcript 的读写端点与订阅连接。
   - 唯一 FastAPI → 注册路由 → PrincipalResolver 中间件，`cors_allow_origins` 非空时再在其外层加装 CORS。
   - lifespan 启动时先清扫一次中断的 prompt 行，起心跳与清扫两个循环，然后开队列连接、起三个 worker。
3. 关停顺序：**先收 worker 与队列连接，再按第一方取消收掉在跑的运行，然后关镜头素材的 HTTP 客户端，最后 dispose engine**。
4. 启动期**不做任何业务表 provisioning**；表结构只经人工 `make db-upgrade` 演进。

## 5. 配置系统

**一条线切开：YAML 管形状，环境变量管值。**

- `server/configs/config.yaml` 声明装什么、什么形状，它进仓；全部模型 frozen + `extra="forbid"`，`models.*.api_key_env` 是 YAML 里**唯一**留着变量名的地方。
- 环境变量给地址与凭证，**不进仓**。`config/models.py` 里的 `*Env` 类每个字段用 `validation_alias` 写死变量名，**那几个类就是这个服务的环境变量清单**；缺了哪几个一次全报出来，报的是变量名本身。变量名不带品牌 / 公司前缀。**空串与只有空白等于没设。**

`server/agents/agents.yaml`（路径由 `--agents` / `AGENTS_FILE` 给出）说启用哪些 agent、各自用哪份官方 spec、谁带谁，同样 frozen + `extra="forbid"`。**「没有 agent」由文件内容表达（`agent: {}`），不由文件缺席表达。** 字段语义：键名即 agent id；`spec` 相对本文件目录、允许为空，同目录 `instructions.md` 自动并入；`model` 必填，引用 `config.yaml` models 段的键名，spec 里的 `model:` 一律被覆盖，引用未声明的名字即装配期报错；`skills` 从同级 `skills/` 库里挑；`capabilities` 是登记在 `app/capability_table.py` 的名字，不写即不挂；有 `subagent` 段即主从，下属的 `spec` / `skills` / `capabilities` 各挂各的、不继承主 agent，`timeout_seconds` / `max_calls` / `on_failure` 三个字段名与 harness SubAgent 一致。

### 能力挂载（skill 与 capability）

**挂什么能力由声明决定，一个 agent 只拥有声明给它的那几样。**

- **skill** 是模型面文本资产，放 `server/agents/skills/<skill 名>/`（`SKILL.md` + 可选 `references/`）；挂了 skill 库就一定同时挂 `get_skill_reference`，它只读得到挂给本 agent 的 skill 的 `.md`。
- **capability** 是一组类型化工具，实现在 `capabilities/`，名字登记在 `app/capability_table.py`。名字没登记、或表里 `REQUIRES` 要求同挂的另一件（`shot_video` 要求 `workspace`）没声明，都是装配期报错。本仓的工具一律经 capability 挂载，`shared_capabilities` 保持空着。
- 每个能力自带一张「工具名 → 参数 → display」的表（`display_table()`，与工具同文件），组合根合成一份注册表，同一实例递给实时与历史两条路；同一件工具登记两遍即装配期报错。
- 单工具的范围规则一律挂在登记时的验证器上（`args_validator`），在执行之前跑，工具体不判范围；地址类参数只收这段对话里出现过、且声明过匹配种类的（`harness/materials.py`，定义见 CONTEXT.md「对话素材」）。完整规则见 [adr/0007](adr/0007-tool-declaration-surface.md)。
- **已落地的能力：`workspace`、`shot_video`**，各自的工具与行为见其 `capability.py`。工具怎么接力归 skill，见 [tool-design.md](tool-design.md) §0。

### 运行依赖（工具怎么拿到调用方身份）

- **一次运行的 deps 就是发起它的 `Principal`**，经官方的依赖注入机制传入；harness 一侧这个参数的类型是 `object` 且全程不解包，组合根的 `deps_for_prompt` 是唯一写具体类型的地方。
- **身份在收下 prompt 的那一刻就定了**，不随请求走：行上记的是属主 id，开跑时按它重建主体，跑到一半吊销 key 不会中断这次运行。
- **deps 只放身份，不放 I/O 句柄**：放的是 `AgentRunDeps`（可信主体 + 所属对话，定义见 CONTEXT.md「运行依赖」），服务经 `app/capability_table.py` 的闭包在装配期注入。不给 deps 实现 `StateHandler`，客户端发来的 state 被忽略。
- **agent id 是唯一权威身份**：装配时以 `name=<id>` 覆盖 spec 里的 `name`，子 agent 的 name 取自其 spec 所在**目录名**；**磁盘扫描显式关闭**（`agent_folders=None`）。

### 模型装配

`config.yaml` 的 `models` 段是一张命名表，`harness/models.py` 把每条声明变成一个官方 `Model`：

- **provider 名 → 哪个 Model 类交给官方 `infer_model`**，本仓不维护分派表；只用 `provider_factory` 接管 provider 的构造，key 与端点一律来自配置，不走官方默认的隐式 env 读取与默认端点。
- **`api: responses` 是唯一越过官方分派的情况**：构造本仓的 `RawReasoningResponsesModel`（官方 `OpenAIResponsesModel` 的子类，让原始思维链能显示）；写在非 OpenAI 兼容的 provider 上即装配期报错。
- **`thinking` 走 OpenAI 方言的 `openai_reasoning_effort`**，不走官方统一的 `thinking` 字段。同名只造一个实例，被多个 agent 引用时共用连接池。

## 6. identity 模块（双主体）

Principal、API key、角色、双主体的定义见 CONTEXT.md「术语」与不变量 2、3；权限模型见 [adr/0002](adr/0002-unified-permission-model.md)。

PrincipalResolver 每 hop 只解析一次，写入 `request.state.principal`；对 http 与 websocket 两种连接都建立 principal，但**只解析、不拒绝**——来源校验由 `websocket_origin_allowed` 提供，**需要 WS 端点自己调用、并在不通过时 close 1008**。行级归属：不可见 `NotFound`、可见无权 `PermissionDenied`（`platform.db.ownership.scope_to_owner` 统一原语）。账号走 fastapi-users；SSO 是 identity-provider 模式，callback 内 verify → PMS（**失败显式终止**）→ oauth 关联 → 铸自有 cookie，此后普通请求零外呼。

## 7. 数据模型与迁移

表结构以 ORM 元数据为准：`iclip` schema 的表在各模块的 `domains/*/infra_sql.py`；`agent_runtime` schema 的表在 `harness/step_store_pg.py`（结构严格镜像官方 pydantic_ai_harness StepPersistence 的存储形状，只换数据库实现）、`harness/jobs.py` 与 `platform/file_store/pg.py`。procrastinate 的排期表落在 `public` schema，DDL 原文冻在迁移 0005 里，升级它就把它新增的迁移脚本抄成一个新 revision。

唯一 provisioning 路径是人工 `make db-upgrade`。迁移契约测试验证 head 与 ORM 元数据零漂移，覆盖 `iclip` schema 下的**全部**表，每个在这个 schema 里有表的模块都要把自己的元数据加进测试的 `_MODULE_METADATA`；`agent_runtime` 那几张表不在断言范围内，往那个 schema 加表时人工确认一次。

## 8. 路由面

端点、权限与状态码以 [`contract/openapi.json`](../contract/openapi.json) 为准（`make contract` 从后端导出）。合同表达不了的两条：transcript 面的字段名照协议原样（信封 snake_case、实体 camelCase），见 [conventions.md](../contract/conventions.md) §5；WS 帧的 schema **不在 openapi 里**，它归照抄来的 `packages/transcript` zod schema，前端 vendor 那一份。

## 9. 运维

日志走 structlog，级别来自 `ops.log_level`。管理 CLI 见 §3。测试与命令见 [test-design.md](test-design.md) 与 [../AGENTS.md](../AGENTS.md)。

## 10. Transcript（对话记录与订阅）

协议是 kimi code 的 transcript（[adr/0005](adr/0005-transcript-protocol.md)）。**transcript 是投影，不是事实源**：持久事实只有官方 `StepPersistence` 存的那份消息历史。已经跑完的轮子由 `from_messages` 从消息现推，正在跑的那一轮由投影器（官方 `UIEventStream` 的子类）产出操作、落在进程内存的实时状态里；一轮的快照落库之后实时状态才交接掉。

**两条路必须给出逐字相同的结构**，所以编号一律从确定的事实算出来（轮 = 一条 prompt 的全部 run，映射在 `agent_runtime.agent_job_runs`；步 = 这一轮里第几次模型响应；块 = 正文与思考的次序），并有一组对齐测试钉住。

**prompt 队列落在 `agent_runtime.agent_jobs`**，不待在进程内存：「一段对话同时只跑一条」由部分唯一索引挡住，在跑的那条行由租约认领，中断的行由清扫续跑（[adr/0006](adr/0006-durable-runs.md) 决策 1）。`steered` 与 `awaiting` 是内部状态，对外一律报 `running`。

**审批是 run 的结束点，不是 run 内的等待**（[adr/0006](adr/0006-durable-runs.md) 决策 4）：要审批的工具只挂顶层 agent，它的 `output_type` 是 `[str, DeferredToolRequests]`，子代理保持 `str`；决定记在票据行上，凑齐一次响应里的全部审批才起续跑 run，画进同一轮。

**一条 WebSocket 管多段对话**（`WS /ws`，不带对话 id）：订哪几段由客户端逐帧 `subscribe_v2` 说，每段各挂一个监听器、各记一份水位，发出去的每一帧带 `session_id` 供客户端分流。建连时只核登录与 `agent:run`，**每次订阅再核这段对话看不看得见**（看不见与不存在同一个待遇）。实时状态每 worker 一份：订阅打到另一个 worker 时看不到那一轮，且不报错。

## 11. 媒体生成

一次生成是一行持久事实，全程在 `iclip.generation_jobs` 里推进：HTTP 只受理与查询，调外部接口是后台三条 procrastinate 队列（图片提交、视频提交、状态轮询，各自一个 worker）的事，排期字段不在这张表上。开关是 `VIDEO_SUBMIT_URL`，且对象存储必须开着。定义见 CONTEXT.md「生成任务」与不变量 10，排队与判失败的规则见 [adr/0004](adr/0004-generation-queue-in-postgres.md)。

## 12. 对话（会话）

对话的定义见 CONTEXT.md「对话」与不变量 8。会话 id 由服务端在 `POST /conversations` 发放，用来归档运行、划工作区地盘、分实时状态；消息 id（`prompt_id`）由客户端铸，同一段对话里重发同一个不会多起一次运行；运行 id 由运行驱动铸（`{agent id}-{短 uuid}`）并交给引擎，于是它同时是消息上的 `run_id` 与阶段账本的主键——**顶层 agent 的 `StepPersistence` 因此不设 `agent_name`**。

**一段对话「在忙什么」由 `agent_jobs` 表算**，规则在 `JobQueue.activities`，帧在写入那一刻发（[adr/0008](adr/0008-activity-from-agent-jobs.md)）。

**删除对话连带删掉工作区文件，这条线接在组合根**：conversations 只声明口子（`PurgeDerived`、`ReadHistory`、`ListDerivedFiles` / `ReadDerivedFile` / `WriteDerivedFile`、`WorkspaceDocumentValidator`）并做归属判断，命名空间只在 `capabilities/workspace/scope.py` 一处拼，路径语法归存储那一侧定；**先删派生的、再删对话行**，运行记录不删。工作区文件属主可写（整份覆盖，带版本号），写入前按路径过校验器；每写一次发一帧 `event.workspace.file_changed`，界面按 `version` 判断正文变没变。

## 13. 产品资料查询

`GET /products/{styleNo}`：一个款号进去，拿到这个款的品牌、品类、颜色和产品图。**只读、零副作用、不建表**——数据在外部一个 Postgres 里（PDM 经 CDC 同步的副本），唯一 SQL 出口是 `catalog_pg.py`，一条 CTE 一次往返，连接在会话层设成只读。码→名字的对照表冻在 `tables.py` 里，图片地址 = `PRODUCT_IMAGE_BASE_URL` + object key。开关是 `PRODUCT_CATALOG_DATABASE_URL`。定义见 CONTEXT.md「产品资料」。

## 14. 创作需求单

定义见 CONTEXT.md「创作需求单」：**没有属主**，不用 `platform/db` 的行级归属原语，看得见但不让改是 403。状态机四档 `draft` →(publish)→ `published` →(confirm)→ `confirmed`，后两档都可 withdraw 到终态 `withdrawn`，delete 只在 `draft`；走不通的流转一律 409，每个写方法都带状态守卫（`expect=`），对不上就一行也改不到。认领人记在 `task_assignees`（`task_id` + `user_id` 联合主键挡重复认领）。

`style` 快照由服务端经 `ports.py` 的 `StyleSnapshots` 协议抄自产品资料库，创建时冻结，真身在 `app/task_styles.py`；`published` 之后能改的只剩管理信息与 `schemas.PLANNER_FIELDS` 那五项，冻结字段有一项不同就拒。

## 15. 爆款视频查询

`POST /inspirations/videos/search`（`styleWmsList`、`sortBy`、`limit`）：按 WMS 编号过滤，在库里按指定维度排序后截断。**只读、零副作用、不建表**——数据在外部只读库（数仓爆款榜），唯一 SQL 出口是 `catalog_pg.py`。排序维度是封闭枚举，进 SQL 的是代码里那张表的值；指标原样给，钱走 `Decimal`。开关是 `INSPIRATION_DATABASE_URL`。定义见 CONTEXT.md「爆款视频」。

## 16. 素材登记表与直传

定义见 CONTEXT.md「素材」。两条入库路径：`POST /uploads/sign` 发一个 assetId、按它算出 key、签一条限时 PUT 地址（不落库、不留内存状态）→ 浏览器 PUT 到 OSS（字节不穿过应用进程）→ `POST /assets/{assetId}` 回桶里核实真实 key、多大、什么类型，落一行；`POST /assets/import` 给外部地址 → 搬进桶里 → 落一行，`assetId` 按源地址算，同一个地址只搬一次。

登记之前 assetId 还不是一份素材，`GET /assets/{id}` 一律 404；登记端点没有请求体，大小上限只在登记这一步卡，没被登记的对象按 `uploads/` 前缀清理。行上存 object key，不存 URL；不做归属过滤，`creator_user_id` 只是查询维度与审计依据。需求单封面（`app/task_styles.py`）不经过登记表。
