# iclip-agent 架构文档

> **维护约定**：本文只记录现状，随实现同步更新——装配顺序、模块依赖、路由面、表结构变更时同步本文；未实现的部分不进本文。领域语言见 [CONTEXT.md](CONTEXT.md)，测试策略见 [test-design.md](test-design.md)。

## 1. 定位与运行拓扑

iclip-agent 是 Productor 视频创作产品的后端，也是跨端合同的定义方：模块化单体，单个代码库（`server/` + `web/`）。**PostgreSQL 数据库是本系统全局唯一的事实源**。

双主体身份体系：Cookie 会话用户 + Bearer API key 机器用户，浏览器经同源 `/api`（反代 rewrite）进来，两者都由 `server/` FastAPI（每 worker 一份）的 PrincipalResolver 解析成唯一信任点。Agent 引擎是 PydanticAI，隔离在 `harness` 围栏内；agent 的运行历史（run 血缘、逐步事件、可续跑快照、工具副作用）落 Postgres 的 `agent_runtime` schema。模型经 `config.yaml` 的命名表装配，agent 在 `agents.yaml` 里引用名字。

agent 运行不绑在发起它的 HTTP 请求上：运行在后台跑，产出落进进程内的实时状态，HTTP/WS 只订阅（见 §10 与 [adr/0005](adr/0005-transcript-protocol.md)）。**实时状态是投影，不是事实源**；持久事实只在 Postgres。

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

围栏由 tach（`server/tach.toml`）与架构单测（`server/tests/unit/architecture/test_architecture.py` 的 `FRAMEWORK_FENCES`）强制，只走 `server/src/`，名单在代码里；新增一个碰 SQL 或框架的文件要在 `FRAMEWORK_FENCES` 加一行。跨模块只准 import 对方 `public.py`。能力包之间互不 import：两件能力要共用的东西下沉到 `platform/` 做成协议，组合根把同一个实例递给两边。接口随首个实现定义，不提前写投机 ABC。

**外部存储落点**：实现官方协议的后端跟着「说这门协议的那一层」走（`harness/step_store_pg.py` 是官方 `StepStore`/`MediaStore` 协议的 PG 后端，`harness/prompts.py` 是 prompt 队列的两张表 `prompts` 与 `prompt_runs`——它们归运行驱动所有）；模块或能力包自有的表放自己模块里的 `infra_sql.py`；`platform/db/` 放跨模块复用的查询原语（`scope_to_owner`）；`platform/object_store/` 是公开对象存储的适配器，业务侧只认协议（`PublicObjectStore`、`SignedUploadStore`），桶里的完整布局在 `layout.py`，每一根 key 都由它发；`platform/file_store/` 是命名空间化文本文件存储的 PG 后端（表 `agent_runtime.workspace_files`），能力侧只认 `FileStore` 协议；`domains/products/catalog_pg.py` 与 `domains/inspirations/catalog_pg.py` 读外部只读源，不是本模块自有的表；engine 只在 `app/` 建。

## 3. 目录布局

| 路径 | 职责 |
|------|------|
| `server/src/iclip/main.py` / `asgi.py` | CLI serve 入口 / ASGI 导出入口 |
| `server/src/iclip/app/` | **唯一组合根**：装配、entrypoints、lifespan + `capability_table.py`（capability 的名字表）+ `task_styles.py`（需求单款号快照的实现） |
| `server/src/iclip/config/` | RuntimeConfig：YAML 源（形状）+ `*Env` 类（环境变量清单） |
| `server/src/iclip/domains/<模块>/` | 业务模块，每个是 `models.py`/`schemas.py`/`repository.py`/`infra_sql.py`/`service.py`/`api.py`/`module.py`/`public.py` 的组合：`identity/`（另有 `middleware.py` PrincipalResolver、`rbac.py`、`sso.py`、`pms.py`、`accounts.py` fastapi-users 装配，见 §6）、`agents/`（agent 运行的 HTTP 面，`public.py` 的 `AgentRunDeps` = 一次运行的身份 + 所属对话；只认识注入进来的运行入口）、`conversations/`（§12）、`generation/`（§11；`queue.py` 三条队列 + 任务体 + 捡卡死任务，`multiflow.py` 视频 / `nano_banana.py` 图像 provider）、`products/`（§13；`catalog_pg.py` 外部只读源的唯一 SQL 出口、`tables.py` 码→名字的常量表，自己不建表）、`inspirations/`（§15；同样只有 `catalog_pg.py`，自己不建表）、`projects/`（需求单与对话各自持有指向它的那一列）、`tasks/`（§14；`ports.py` 按款号抄快照的协议，不依赖任何别的业务模块）、`assets/`（§16；`images.py` 量图片尺寸，`api.py` 挂 `/uploads/*` 与 `/assets/*`） |
| `server/src/iclip/harness/` | 通用 agent 内核：`step_store_pg.py`（官方 StepPersistence / MediaStore 协议的 PG 后端）、`models.py`（命名模型装配）、`agents.py`（agent 装配）、`skills.py`（skill 库装配 + 读 references 的工具）、`prompts.py`（prompt 队列的表）、`media.py`（媒体引用的文法）、`materials.py`（对话素材范围，定义见 CONTEXT.md）、`transcript/`（投影器、实时状态、从消息现推、运行驱动、对外那一口） |
| `server/src/iclip/platform/transcript/` | transcript 协议的形状：`ops.py`（实体与操作，camelCase）、`wire.py`（WS 帧与 REST 信封，snake_case）。照抄来的外部合同，harness 与 HTTP 面都认它，谁都不拥有它 |
| `server/src/iclip/capabilities/` | capability 实现（落地一件就在 `app/capability_table.py` 登记名字）：`workspace/`（`capability.py` 六件工具、`scope.py` 运行 → 命名空间的规则）、`shot_video/`（`capability.py` 四件工具、`shots.py` 镜头区间解析 + 等间隔采样、`board.py` 预览板拼版与帧号叠印、`grid.py` 切格几何、`prompt.py` 整版 prompt 拼接、`ffmpeg.py` 异步子进程 + 取素材、`parser.py` 视频拆解的 Responses 适配器 + 提示词、`ports.py` 对外要的三个窄协议） |
| `server/src/iclip/platform/` | `db/`（ownership 行级归属原语）、`http.py`（领域错误→HTTP 单点映射）、`object_store/`（阿里云 OSS：`layout.py` + `oss.py`）、`file_store/`（`store.py` 路径语法 + `FileStore` 协议 + `FileSpace`「存储 × 命名空间规则」，`pg.py` PG 后端） |
| `server/src/iclip/common/` | 领域错误分类（`errors.py`：DomainError 及其五个子类） |
| `server/configs/config.yaml` | 唯一 Runtime Configuration（只有形状；地址与凭证在环境变量里） |
| `server/agents/` | agent 装配声明 `agents.yaml` + 每 agent 一个子目录（`agent.yaml` 官方 spec + `instructions.md` 提示词）+ `skills/`（skill 库，一个子目录一个 skill） |
| `server/migrations/versions/` | Alembic 迁移，一个 revision 一个文件 |
| `server/scripts/admin.py` | 引导型管理 CLI（set-roles / list-users / issue-key），直连 DB 绕过 API，用于非 SSO 场景的 root 引导（SSO 场景用 `ROOT_EMAIL`） |
| `web/` | 产品前端（React SPA，经同源 `/api` 消费合同）；命令与边界见 [../web/AGENTS.md](../web/AGENTS.md) |
| `contract/` | 跨端合同：`openapi.json` 由 `make contract` 从后端导出，前端据此生成类型与 zod；`conventions.md` 写合同表达不了的约定 |

## 4. 装配流程

1. `asgi.py` 读 `CONFIG_FILE`（缺省 `configs/config.yaml`）→ `load_runtime_config()`：只做 YAML 加载与结构校验（extra=forbid），不读任何环境变量。同时读 `AGENTS_FILE`（缺省 `agents/agents.yaml`）→ `load_agent_declarations()`：结构校验 + 把 `spec` 解析成绝对路径、找出同级 `instructions.md`、把同级 `skills/` 库解析成绝对路径；声明文件、spec 文件或目录缺失即报错。
2. 组合根 `app/bootstrap`：`resolve_settings()` 把 YAML 的形状与环境变量的值合成运行值（缺哪几个变量一次全报出来）→ 构造 async engine（asyncpg，每 worker 一个连接池）→ 装配 identity 模块（repository → service → api）→ 可选 SSO/PMS 协议客户端（`SSO_BASE_URL` 空即不装）→ 装 conversations 模块，把它的「删对话时连带清掉派生物」「列/读派生文件」口子接到工作区的清空与读取上 → `OSS_BUCKET` 非空时建公开对象存储（素材、生成、镜头帧共用这一只桶）并装 assets 模块（没有桶整组路由不挂）→ `media_generation` 段 + `VIDEO_SUBMIT_URL` 非空时装 generation 模块（两家 provider 一起装，缺一个 env 即报错；对象存储没开也报错）→ `VIDEO_UNDERSTANDING_URL` 非空时建镜头素材能力取素材用的 HTTP 客户端并检查 PATH 上有 ffmpeg/ffprobe（此时媒体生成必须也开着）→ `PRODUCT_CATALOG_DATABASE_URL` / `INSPIRATION_DATABASE_URL` 非空时各建一个只读 engine（会话层设成只读）并装 products / inspirations 模块 → 装 tasks 模块，把「按款号抄快照」协议接到产品资料库与桶上（缺一个就接一个只会拒绝的替代品）→ 把 agent 声明翻译成 harness 入参并 `build_agent_registry()`（模型/凭证/spec 缺失在此 fail fast；capability 名字表在这一步建起来）→ 建实时状态、prompt 队列与运行驱动，装上 transcript 的读写端点与订阅连接 → 新建唯一 FastAPI → 注册路由 → 安装 PrincipalResolver 中间件，`cors_allow_origins` 非空时再在其外层加装 CORS → lifespan 启动时先清扫一次中断的 prompt 行、再起心跳与清扫两个循环，然后开队列连接、起三个 worker；关停顺序：**先收 worker 与队列连接、再按第一方取消收掉在跑的运行（它们要落库），然后关镜头素材的 HTTP 客户端，最后 dispose engine**。
3. 启动期**不做任何业务表 provisioning**；表结构只经人工 `make db-upgrade` 演进。

## 5. 配置系统

**一条线切开：YAML 管形状，环境变量管值。**

- `server/configs/config.yaml` 说「装什么、什么形状」——声明哪些模型、哪些节奏、哪些名字。它进仓。经 pydantic-settings `YamlConfigSettingsSource` 加载，全部模型 frozen + `extra="forbid"`。段与字段以该文件为准；`models.*.api_key_env` 是 YAML 里**唯一**留着变量名的地方。
- 环境变量说「连到哪儿、用什么凭证」——地址与密钥。**它不进仓**。读取交给 pydantic-settings：`config/models.py` 里的 `*Env` 类每个字段用 `validation_alias` 写死对应的变量名，**那几个类就是这个服务的环境变量清单**；缺了哪几个一次全报出来，报的是变量名本身。变量名一律不带品牌/公司前缀。**空串与只有空白等于没设**（`min_length=1` + 先 strip）。

另一份声明文件 `server/agents/agents.yaml`（路径由 `--agents` / `AGENTS_FILE` 给出）是 agent 装配声明：启用哪些 agent、各自用哪份官方 spec、谁带谁。同样 frozen + `extra="forbid"`。**「没有 agent」由文件内容表达（`agent: {}`），不由文件缺席表达**。键名即 agent id；`spec` 相对本文件目录，同目录 `instructions.md` 自动并入；`model` 引用 `config.yaml` models 段的键名，必填，spec 里的 `model:` 一律被覆盖，引用了未声明的名字即装配期报错；`skills` 从同级 `skills/` 库里挑，`capabilities` 是登记在 `app/capability_table.py` 的名字，不写即不挂；有 `subagent` 段即主从，下属的 `spec`/`skills`/`capabilities` 各挂各的，不继承主 agent，`timeout_seconds` / `max_calls` / `on_failure` 三个字段名与 harness SubAgent 一致。spec 文件允许为空。

**每个 agent（含子代理）装配时都挂官方 `StepPersistence`**，store 为 `PgStepStore`（见 §7）；`step_store` 是必填参数、无内存兜底默认值。子代理的 `parent_run_id` 由 harness 的 contextvar 自动推断。

### 能力挂载（skill 与 capability）

**挂什么能力由声明决定，一个 agent 只拥有声明给它的那几样。** 两类材料分开走：

- **skill** 是模型面文本资产（流程知识、判断标准、产出格式），放 `server/agents/skills/<skill 名>/`（`SKILL.md` + 可选 `references/`）。库路径在加载声明时解析成绝对路径。挑了库里没有的名字即装配期报错。挂 skill 库就一定同时挂 `get_skill_reference` 工具（`harness/skills.py`），访问边界与挂载范围严格一致：没挂给这个 agent 的 skill，它的 references 也读不到；越界、非 `.md`、不存在都回可重试提示并报出有哪些文件，自家资产编码坏了则直接失败。
- **capability** 是一组类型化工具（外加可选的指令与钩子），实现在 `capabilities/`，名字登记在 `app/capability_table.py`。名字没登记即装配期报错；一个名字要求同挂另一个（表里的 `REQUIRES`，如 `shot_video` 要求 `workspace`）而声明里少了，同样装配期报错。官方 spec 的 `capabilities:` 段只传得进 YAML 能序列化的值；需要运行期对象（连接池、domain 服务）的能力走 `agents.yaml` 的名字表。`shared_capabilities` 保持空着；本仓的工具一律经 capability 挂载，不直接注册到 `Agent(toolsets=[...])` 上。

**工作区（`capabilities: [workspace]`）**：六件工具（`read_file` / `write_file` / `edit_file` / `delete_file` / `list_files` / `search_files`），落在 Postgres，只放文本（二进制走内容寻址媒体：`media` 表 + `media+sha256://`）。一段对话一个工作区，主 agent 与它的下属共用（`scope.py`）：命名空间是 `{user_id}/{conversation_id}`，对话 id 取自 `deps`（`AgentRunDeps`），**不是**运行自己的 `ctx.conversation_id`；算不出命名空间就让这次运行失败，绝不退回公共命名空间。改一段用精确字符串匹配，不用行号；`edit_file` 内部带版本号写回，版本号不进工具参数。容量上限在存储层强制，每次变更先拿命名空间的 advisory 锁，「容量满」和「版本冲突」是两种可分辨的错误。

**镜头素材（`capabilities: [shot_video]`）**：四件工具，`video_parser_md`（拆参考片，文档写进工作区）→ `plan_shot_frames`（整片按秒抽帧，按结构层级拼成带帧号的预览板）→ `generate_shot_frames`（按逐帧 visual_prompt 出一张 2×2 网格图并切成 4 帧）→ `ReadMediaFile`（把一张图附进上下文给模型看）。出图走 generation 域的服务，帧与切格产物按内容哈希落生成用的公开对象存储；开关是 `VIDEO_UNDERSTANDING_URL`。

- 接力靠工作区里的两份文件：拆解文档（`video/<名>.md`）与取帧登记表（`frames/extraction.json`）。两件能力在构造器里收同一个 `FileSpace`（组合根 `capability_table.py` 造一个递给两边）；命名空间的规范化（挡住 `..` 与空段）收在 `FileSpace.resolve()` 里。`shot_video` 不 import `workspace/`，也不在工具里 `ctx.capabilities` 认领兄弟能力。能力包不注入指令（`get_instructions()` 返回 `None`），工具怎么接力归 skill，见 [tool-design.md](tool-design.md) §0。
- 地址只收这段对话里出现过的（`harness/materials.py`，`run_materials(ctx.messages)`）：定义与判据见 CONTEXT.md「对话素材」。报错不回显被拒的地址；种类只在声明过时查；判定用子串包含。
- 视频拆解不走命名模型表，也不做成 agent：`parser.py` 自己说一次 Responses 协议，形状与两家生成 provider 一致，地址与凭证来自环境变量；提示词写死在 `parser.py` 里。
- 出图的重试与升级归工具，不归 provider：工具先在 dev 试、试不通再升 pro，**每次尝试各落一行 `generation_jobs`**，渠道记在行上。不看错误码：任何失败都沿 dev→dev→pro 往下试，出了图就停，试完把最后一次的错误码原样报出来；等待时限用尽时不再提交下一个。升级只在失败时发生。
- 切格按图上真实的分隔带走（在降采样到 640 宽的灰度图上检测，裁剪回到原图坐标，四格一次 `filter_complex` 裁完），检测不到时退回等分并在结果里明说。整图固定按 `4k` 出。预览板与切出来的帧由 `ReadMediaFile` 按需读进上下文，附的是地址不是字节，缩到长边 1024 靠对象存储的缩放参数。ffmpeg 一律异步起进程、每个都有超时。

### 运行依赖（工具怎么拿到调用方身份）

**一次运行的 deps 就是发起它的 `Principal`**，经官方的依赖注入机制传入：运行驱动按 prompt 行上的属主把主体拼回来 → 官方 `run_stream_events(deps=…)`。业务工具按 `RunContext[Principal]` 写，子 agent 由官方自动转发（`deps=ctx.deps`）。harness 一侧这个参数的类型是 `object` 且全程不解包；组合根的 `deps_for_prompt` 是唯一写具体类型的地方。

**身份在收下 prompt 的那一刻就定了**，不随请求走：一条消息可能排了很久才轮到，那时发起它的 HTTP 请求早就没了。行上记的是属主 id，开跑时按它重建主体——排队期间被停用的账号因此拿不到运行。

**deps 只放身份，不放 I/O 句柄**：服务经 `app/capability_table.py` 的闭包在装配期注入。deps 里放的是 `AgentRunDeps`（可信主体 + 所属对话）；派活时官方转发 deps、不转发运行自己的 `conversation_id`。定义见 CONTEXT.md「运行依赖」。

**造 deps 的那个回调同时是会话的关卡**：它拿到协议解析出的两个 id（会话与运行），核对这段对话是不是调用者的、是不是这个 agent 的，并把这次运行记在对话上（`last_run_id`）。它发生在开流之前，是个可等待的调用；重连时会再走一遍，核对可以重复做。

- **不给 deps 实现 `StateHandler`。** `Principal` 是普通 frozen dataclass，客户端发来的 state 被忽略并留一条 warning。
- **身份是每次运行传入的，不是装配期挂上的**；**捕获即冻结**：主体在发起时抓一次，跑到一半吊销 key 不会中断这次运行。
- **agent id 是唯一权威身份**：装配时以 `name=<id>` 覆盖 spec 里的 `name`；子 agent 的 name 取自其 spec 所在**目录名**。**磁盘扫描显式关闭**（`agent_folders=None`）。

### 模型装配

`config.yaml` 的 `models` 段是一张命名表，`harness/models.py` 把每条声明变成一个官方 `Model`：

- **provider 名决定厂商适配**（schema 处理、严格输出开关、流式前导空白等）。**「provider 名 → 哪个 Model 类」交给官方 `infer_model`**，本仓不自己维护分派表；只用 `provider_factory` 接管 provider 的构造：key 与端点一律来自配置，不走官方默认的隐式 env 读取与默认端点。各家构造签名不统一：收 `base_url` 的直接传，只收 `api_key` 的走 `openai_client`。
- **`api: responses` 是唯一越过官方分派的情况**：构造本仓的 `RawReasoningResponsesModel`（官方 `OpenAIResponsesModel` 的子类）并塞入我们的 provider；写在非 OpenAI 兼容的 provider 上即装配期报错。**子类只做一件事：让原始思维链能显示**——在 SDK 事件流上给每条原始块补一条同 id 的 summary 块，两者合进同一个 ThinkingPart，`provider_details.raw_content` 照旧保留。
- **`thinking` 走 OpenAI 方言的 `openai_reasoning_effort`，不走官方统一的 `thinking` 字段**；chat 路径写了 `thinking` 就按官方分派选出的类再造一次。
- 同名只造一个实例，被多个 agent 引用时共用连接池。

## 6. identity 模块（双主体）

Principal、API key、角色、双主体的定义见 CONTEXT.md「术语」与不变量 2、3；权限模型见 [adr/0002](adr/0002-unified-permission-model.md)。

- **PrincipalResolver** 每 hop 只解析一次：cookie → JWT 验签一次 + 活跃用户加载一次；Bearer → SHA-256 查表 + 活跃 key/属主加载（过期/吊销/属主停用即拒）。写入 `request.state.principal`。中间件对 http 与 websocket 两种连接都建立 principal，但**只解析、不拒绝**。来源校验以 `websocket_origin_allowed`（无 Origin 放行 / 白名单跨域 / 否则同源）提供，**需要 WS 端点自己调用、并在不通过时 close 1008**。`require_permission(perm)` 只读 Principal。行级归属：不可见 `NotFound`、可见无权 `PermissionDenied`（`platform.db.ownership.scope_to_owner` 统一原语）。
- **账号**：fastapi-users（cookie transport + JWT strategy）；登录支持 username 或 email；密码注册强制 `viewer`；登录 204 + Set-Cookie，响应体不含 token。API key 为 `iclip_sk_` + 32 字节 urlsafe base64，只存哈希 + 前缀；本人管理自己的 key，`users:manage` 管全部。角色 root/editor/viewer 代码内预置（root = 全量计算），无角色管理表。
- **SSO**（identity-provider 模式）：跳转 `{base}/sso/issue/jwt?redirect_uri=...&_fromApp=...`；验证 `GET {base}/sso/rpc/session/verify?jwt=...` → `{result:"OK", userSession:{innerUserId, unionId, name, email, avatarUrl}}`；PMS `GET {base}/pms-console/user/selectUserById/{innerUserId}`（Authorization: SSO jwt）→ `{success:true, data:{city, jobTitle, depts:[...]}}`。callback 内 verify → PMS（**失败显式终止**）→ fastapi-users oauth 关联（`associate_by_email`，`oauth_name="wangoon_sso"`，首登默认 editor）→ 铸自有 cookie。此后普通请求零外呼。

## 7. 数据模型与迁移

表结构以 ORM 元数据为准：`iclip` schema 的表在各模块的 `domains/*/infra_sql.py`；`agent_runtime` schema 的表在 `harness/step_store_pg.py`（`runs` / `events` / `snapshots` / `tool_effects` / `media`，结构严格镜像官方 pydantic_ai_harness StepPersistence 存储形状，只换数据库实现、不改表结构）与 `platform/file_store/pg.py`（`workspace_files`，本仓自有）。procrastinate 的排期表 `public.procrastinate_*` 落在 `public` schema，DDL 原文冻在迁移 0005 里；升级它的做法是把它新增的迁移脚本抄成一个新 revision。写入方 `harness/step_store_pg.py` 实现官方异步 `StepStore` / `MediaStore` 协议，挂到 `Agent(capabilities=[StepPersistence(...)])`；DDL 由 Alembic 拥有（`server/migrations/versions/`），store 不自建表。

唯一 provisioning 路径：人工 `make db-upgrade`（`alembic upgrade head`，所有环境一致）；迁移契约测试用 scratch 环境验证 head 与 ORM 元数据零漂移。该断言覆盖 `iclip` schema 下的**全部**表，每个在这个 schema 里有表的模块都要把自己的元数据加进测试的 `_MODULE_METADATA`；`agent_runtime` 那几张表不在断言范围内，往那个 schema 加表时迁移要人工 `make db-upgrade` 确认一次。

## 8. 路由面

端点、权限与状态码以 [`contract/openapi.json`](../contract/openapi.json) 为准（`make contract` 从后端导出）。合同表达不了的两条：transcript 面的字段名照协议原样（信封 snake_case、实体 camelCase），见 [conventions.md](../contract/conventions.md) §5；WS 帧的 schema **不在 openapi 里**，它归照抄来的 `packages/transcript` zod schema，前端 vendor 那一份。

## 9. 运维

日志：structlog（结构化，级别来自 `ops.log_level`）。管理 CLI 见 §3 的 `server/scripts/admin.py`。测试与命令见 [test-design.md](test-design.md) 与 [../AGENTS.md](../AGENTS.md)。

## 10. Transcript（对话记录与订阅）

一次 agent 运行分成两半：**跑**和**看**。跑的那一半是个后台任务，不绑在任何一次 HTTP 请求上；看的那一半是订阅。协议是 kimi code 的 transcript，理由见 [adr/0005](adr/0005-transcript-protocol.md)。

**transcript 是投影，不是事实源。** 持久事实只有官方 `StepPersistence` 存的那份消息历史：

- 已经跑完的轮子由 `from_messages` 从消息现推，终态从官方记的 run 结束事件读。
- 正在跑的那一轮由投影器（官方 `UIEventStream` 的子类）从引擎事件流产出操作，落在进程内存的实时状态里。
- 一轮的快照落库之后，实时状态就把它交接掉（`mark_snapshot_persisted` → `drop_persisted_turns`）。**先确认落库再放手**：中间要是先丢了，两边都拿不出这一轮。

两条路必须给出逐字相同的结构，否则界面会在刷新的瞬间变形且不报错，所以编号一律从确定的事实算出来（轮 = 一条 prompt 的全部 run，映射在 `agent_runtime.prompt_runs`，由 `attach_run` 写入，没有映射的 run 各自成轮；步=这一轮里第几次模型响应、块=正文与思考的次序），并有一组对齐测试钉住。轮的终态取最后一次 run 的结束事件；更早那几次 run 没跑完的，其最后一步为 `interrupted`。

**批次号与补批**：实时状态每落一批操作发一个号，每 agent 连续，同时进一个有界的补批日志（2000 批）。客户端断线后带着水位来要，要得回就补，要不回答 `complete: false` 让它整页重拉。

- **进程重启后号从 1 重来，而这是安全的**：客户端收到 `transcript.reset` 会把本地水位**无条件覆写**成帧里的 `seq`（不是取较大值）。什么时候必须先发 reset 收在 `subscription.subscribe_frames` 一处——判错了服务端一切正常，客户端安静地停止更新。
- **实时状态的方法全是同步的，中途一个 `await` 都不能有**：发号、落地、进日志、递给在听的人四件事必须一起生效。asyncio 只在 await 处切换任务，所以没有 await 的方法天然是一个临界区。

**一条 WebSocket 管多段对话**（`WS /ws`，不带对话 id）：订哪几段由客户端逐帧 `subscribe_v2` 说，每段各挂一个监听器、各 pin 一次、各记一份水位，发出去的每一帧带 `session_id` 供客户端分流。建连时只核登录与 `agent:run`，**每次订阅再核这段对话看不看得见**（看不见与不存在同一个待遇，回执里 `not_found`，整条连接不动）。

**运行驱动**（`harness/transcript/runner.py`）是唯一知道「这段对话此刻有没有在跑」的地方，停止、插话、审批三条人机往返都归它：停止走官方 `CancellationToken`（不是 `task.cancel()`——外部取消是 `BaseException`，官方的收尾分支接不住，终态操作发不出去）。

**插话**用一个 capability 在 `before_run` 接住这次 run 的 `ctx`，到达时当场 `ctx.enqueue(priority='asap')`。不先攒着等下一次模型请求：官方第二道 drain 在 run 本来要结束时把晚到的 asap 捞出来做一次 redirect，攒着的那条压根没进官方队列，捞不到。一条插话要么进这次 run、要么退回 `queued`——run 收场时清扫一遍官方队列里没被读走的；用户按了停止时不退回，跟着这一轮一起撤销。递进去的那几条按 `run_id` 挂在这一轮下面，结局与它相同。

**prompt 队列**（`agent_runtime.prompts`）落库，不待在进程内存：「一段对话同时只跑一条」由部分唯一索引挡住，不靠先查后写，而实时状态是每 worker 一份、互相看不见。`steered` 与 `awaiting` 是内部状态，对外一律报 `running`——协议的状态联合里没有这两个值。

**审批是 run 的结束点，不是 run 内的等待**（[adr/0006](adr/0006-durable-runs.md) 决策 4）。要审批的工具只挂顶层 agent，它的 `output_type` 是 `[str, DeferredToolRequests]`，子代理保持 `str`。一次 run 以 `DeferredToolRequests` 结束时：

- 运行驱动把此刻的 `all_messages()` 经官方 `StepStore` 协议的 `save_snapshot` 存成 `interrupted` 快照。官方 `StepPersistence` 这一刻不存（未闭合的工具调用过不了它那道门槛），文档写明由调用方持久化；写进同一张表，续跑那侧照旧用 `latest_conversation_snapshot(include_interrupted=True)` 读回来。
- prompt 置内部状态 `awaiting` 并放掉租约；每处以 `running` 判「占着」的地方都把它算进去（含库上那道部分唯一索引），而心跳与清扫只看 `running`——等审批没有租约，不算中断。
- 实时那一轮原样留着不交接：轮仍 `running`、审批卡仍待回应，「这段对话在忙什么」正是从这两样算出来的。
- 人点的头记在 `prompts.decisions`（`{toolCallId: 是否放行}`）上，同值重复提交照原样收下、改主意是 409。一次响应里全部审批都有决定之后 CAS `awaiting → running` 并起续跑 run，带 `deferred_tool_results` 且**不**走 `_close_out`——官方要求这时给出的结果覆盖前沿全部可执行调用，已经执行过的那几次它按末尾那条请求里的返回自动标成跳过。续跑画进同一轮，`attempt` 不加。
- 等待期间插话回 409，新 prompt 排队；撤销把行标 `aborted`，运行驱动把实时那一轮收成取消（审批卡取消、没等到返回的工具卡收成错）再交接放手，随后队首顶上来。悬空的那次调用由下一条 prompt 起 run 时的 `_close_out` 收掉。

历史侧判定一条调用是审批的规则：某一段**干净收尾**（官方记下 `run_completed`）却在末尾那条响应上留着没有结果的调用——只有以 `DeferredToolRequests` 结束才是这个形状。它的结局看同一轮后一段第一条请求里的返回（`denied` 是拒了，其余是放行；收尾补的 `failed` / `interrupted` 不算，那是崩溃续跑把前沿收掉）；还开着的按那条 prompt 的状态定：等审批或已起续跑 → 卡留在 `running`、交互待回应、轮 `running`，撤销 → 轮 `cancelled`、卡收成错、交互已取消，失败 → 轮 `failed`。

**在跑的那条行由租约认领。** 行上四列：`locked_by` 是进程启动时铸的 id，`heartbeat_at` 由持租的那个进程按周期刷新，`interrupt_reason` 写下失去租约的那句事实，`attempt` 记它被重新认领过几次；时间一律取数据库时钟。周期与次数上限由 `config.yaml` 的 `agent_runs` 段给出（`heartbeat_seconds` / `lease_seconds` / `sweep_seconds` / `max_attempts`，租约必须长于心跳，不然装配期报错）。`finish` 与 `attach_run` 都带 `locked_by` 这道 fence，改不动就是租约已经易手，结局由接手那一方定；持租的一方刷不到自己的心跳时，就地按第一方取消停掉那一轮。

**中断的行由清扫续跑。** 心跳停过一个租约、或者关停时被主动释放（`locked_by` 为空）的 `running` 行都算中断。清扫按顺序做三件事：认领次数用完的中断行判 `failed` 并放掉租约，连带把递进那次 run 的插话一并判失败；还有机会的认领下来起一次续跑；有排队却没有在跑的对话，把队首顶上来开跑。关停途中只做第一件。`attempt` 只在重新认领时加一，第一次认领不计入，所以认领次数是 `attempt + 1`，到 `max_attempts` 为止——配 1 即中断后只判失败、不续跑。

续跑是新起一次 run 挂同一条 prompt，按 `prompts.run_id` 与历史分三条路：**没起过 run** 的是首次，照常跑；**老 run 的消息在历史里**，画进它所在那一轮（轮号取 `turn_run_ids` 里那一组的下标加一，不是往后数一个），`user_prompt` 换成固定的续跑触发语，悬空的工具调用照旧用 `deferred_tool_results` 收掉；**老 run 不在历史里**（崩在第一个周期完成之前），按原 `content` 重跑，轮号照常数。后两条路都把递进老 run 的那几条插话改挂新 run（`adopt_steered`），结局跟着续跑那一次。触发语进模型上下文，在 transcript 里显示为老 run 末步末尾的 `role: user` 文字帧，与插话同形。

**优雅关停放手，不撤销。** 关停时在跑的那一轮按第一方取消停掉（at-failure 快照因此落库），行留在 `running`、放掉租约并写下原因，不发终态；没被这次 run 读到的插话退回 `queued`，已经读走的留在 `steered`，由续跑那次 run 定结局。

**续跑的投影器先播种。** 一页时间线同号的轮以实时那份为准，所以续跑起手先把历史推出来的整轮（轮头部、每一步、每一块）写进实时状态，再让投影器接着发：步号、块号、用量与还开着的工具卡都接着它数，老 run 的末步标成 `interrupted`。

**失败的那一轮也在历史里。** 一次运行抛异常时官方只落得下一份 `interrupted` 快照（末尾那次工具调用没有返回），显示与起 run 两侧都把它算上，否则那一轮不但看不见，还会因为下一次运行拿不到它而从此消失、轮号被重用。代价是历史末尾可能带着没有结果的工具调用，而官方不许带着这种历史再发一句新的用户消息；起 run 时用 `deferred_tool_results` 把它们收掉（`runner._close_out`），这是官方留给调用方的口子。收掉的那份结果只说明「没跑成」，副作用发生过没有由官方的工具账本记着。

投影器不给这一轮之外的工具调用建卡：收掉上一轮悬空调用的那份结果会在这一轮第一次模型响应之前作为事件走一遍，建了卡就等于把上一轮的调用画进这一轮，而消息历史那侧把它算在上一轮。报错的文字只挂在轮头部的 `error` 上（用 `repr`，与官方 `run_failed` 事件记的一致），`notice` 块没有产地。

实时状态与「这段对话有没有在跑」都是每 worker 一份：订阅打到另一个 worker 时看不到那一轮，且不报错。

## 11. 媒体生成

一次生成是一行持久事实，从受理到出结果全程在 `iclip.generation_jobs` 里推进。HTTP 只负责受理与查询；调外部接口是后台的事。定义见 CONTEXT.md「生成任务」与不变量 10；排队、轮询、判失败不重投、时钟、图片转存的规则与理由见 [adr/0004](adr/0004-generation-queue-in-postgres.md)。

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

- **排期归 procrastinate，事实归我们**：排期在它的表里（`public.procrastinate_*`，见 §7），`generation_jobs` 上没有排期字段。三条队列各一个 worker，并发各 100；数据库连接只在状态跳转时开合，不跨着 HTTP 调用握着。
- 重试策略不设次数上限，上限由任务体的守卫给：轮询撞上 `job_timeout_seconds` 就写终态，提交重读那行看见 `submitting` 就判失败；收尾的写入带状态守卫（只在这行还停在 `submitting` 时才落）。没见过的 provider 状态一律报错，不当成「还在跑」。
- 捡失联任务的周期任务挂在轮询队列上；worker 心跳每 10 秒一次，断 30 秒判没。信号处理器归 uvicorn，起 worker 时显式关掉 procrastinate 的；关停先给宽限期，到了就打断。
- 视频的 `model` 不给就用配置里的默认模型；图像可选的是 `channel`（`dev`/`pro`）。错误码分「送到了没有」（`PROVIDER_UNREACHABLE` / `PROVIDER_RESULT_UNKNOWN`），不驱动任何自动动作；实际用了哪个模型/渠道记进 `provider_snapshot`。
- **同步接口一步落到终态**：图像那条对账 id（`provider_task_id`）与 `submitted_at` 在写完成态那一步落库；视频那条 `submitted_at` 完成时保持原值。
- **请求类型只有一套定义**（`schemas.py` 的 pydantic 模型）：既是 HTTP 请求体，也是入库形状（`model_dump(by_alias=True)`，camelCase，`kind` 是表上的一列不重复存）。读回来按 `kind` 挑 `TypeAdapter` 校验一遍。响应不含 `provider_snapshot`。

## 12. 对话（会话）

对话的定义与铸造规则见 CONTEXT.md「对话」与不变量 8。会话 id 由服务端在 `POST /conversations` 发放，用来归档运行、划工作区地盘、分实时状态。

运行 id 由运行驱动铸（`{agent id}-{短 uuid}`）并交给引擎，于是它同时是消息上的 `run_id` 与阶段账本的主键——**顶层 agent 的 `StepPersistence` 因此不设 `agent_name`**：设了官方就自己铸一个，与消息上的对不上，轮的终态就查不出来。下属留着名字，它们不进 transcript。

消息 id（`prompt_id`）由客户端铸，用来认领自己的乐观气泡；同一段对话里重发同一个不会多起一次运行。

**一段对话「在忙什么」由两份事实合成**（定义见 CONTEXT.md「对话」）：库里那条占着的 prompt（`running` 或 `awaiting` 都是忙，`awaiting` 另带一件待人处理的审批），与实时状态算出来的那一份（它更细，提问也算待人处理），取更忙的那一边。只看实时状态不行——它是每 worker 一份的进程内存，重启之后是空的。推送那一帧仍由实时状态变化触发，帧本来就是易失的，重连后按列表重拉对齐。

**运行记录（`agent_runtime.runs`）不加指向 `conversations` 的外键**，两边靠 `conversation_id` 字段对上，有索引。`agent_runtime.prompt_runs` 同样不加外键，靠 `run_id` 与消息上盖的那个对上。

**删除对话连带删掉工作区文件，这条线接在组合根。** conversations 只声明「删掉这段对话派生出来的东西」的口子（`PurgeDerived`）；命名空间只在 `capabilities/workspace/scope.py` 一处拼。**先删派生的，再删对话行**。运行记录不删。

**读历史与读工作区文件走同一种口子**：conversations 声明 `ReadHistory`、`ListDerivedFiles` / `ReadDerivedFile`，由组合根接线：历史接到引擎登记表的读取器上，文件接到工作区存储上。这一层只做归属判断；路径语法归存储那一侧定，不合法在组合根翻成 422。工作区文件对外**只读、无推送**，界面按 `version` 判断正文变没变。

## 13. 产品资料查询

`GET /products/{styleNo}`：一个款号进去，拿到这个款的品牌、品类、颜色和产品图。**只读、零副作用、不建表**——数据在外部一个 Postgres 里（PDM 经 CDC 同步的副本），一条 CTE 一次往返，按显式列名读；每一跳过滤 `is_active AND NOT is_source_deleted`，取图那跳还要 `is_current AND status = 'succeeded'`，图按 `content_hash` 去重，颜色走 `style_pdm_id`。码→名字的对照表冻在 `tables.py` 里，查不到返回 `null`；图片地址 = `PRODUCT_IMAGE_BASE_URL` + object key；连接在会话层设成只读。定义见 CONTEXT.md「产品资料」。

## 14. 创作需求单

定义见 CONTEXT.md「创作需求单」：**没有属主**，不用 `platform/db` 的行级归属原语，看得见但不让改是 403。状态机四档 `draft` →(publish)→ `published` →(confirm)→ `confirmed`，`published` 与 `confirmed` 都可 withdraw 到终态 `withdrawn`（改不动、删不掉）；delete 只在 `draft`，仅创建者或治理者；走不通的流转一律 409。**confirm 在 `published` 与 `confirmed` 上都走得通**：认领人追加进 `task_assignees`（`task_id` + `user_id` 联合主键挡重复认领，指向 users 的外键用 restrict），需求单那一行只在 `published` 那一次被 UPDATE 到，`confirmed` 上再认领不动 `updated_at`。`claimedBy=me` 用 `IN (子查询)` 过滤，认领人按 `created_at` 批量取回再按单分组。

`style`（款号、品牌、品类、封面）由服务端经 `ports.py` 的 `StyleSnapshots` 协议抄自产品资料库，创建时冻结，真身在 `app/task_styles.py`。`published` 之后能改的只剩管理信息（标题、优先级、期限）与 `schemas.PLANNER_FIELDS` 那五项；PUT 整体覆盖，服务层拿提交的 brief 和库里的逐字段比，冻结的有一项不同就拒。「发布时期限必须还没到」写在 `UPDATE` 的 `WHERE` 里，用 `now()`。每个写方法都带状态守卫（`expect=`），对不上就一行也改不到，服务层翻译成 409。brief 与款号快照只有一套定义（`schemas.TaskBrief` / `schemas.TaskStyle`，同 §11 的生成请求）。

## 15. 爆款视频查询

`POST /inspirations/videos/search`（`styleWmsList`, `sortBy`, `limit`）：按 WMS 编号过滤，在库里按指定维度排序后截断；爆款榜一行一条视频（`video_id` 主键）LEFT JOIN 打标表拿转存过的可播地址（可能没有）。**只读、零副作用、不建表**。排序维度是封闭枚举，进 SQL 的是代码里那张表的值；排序尾巴上跟一个 `video_id`。指标原样给，钱走 `Decimal`。定义见 CONTEXT.md「爆款视频」。

## 16. 素材登记表与直传

定义见 CONTEXT.md「素材」。`POST /uploads/sign` 发一个 assetId、按它算出 key、签一条限时 PUT 地址（不落库、不留内存状态）→ 浏览器 PUT 到 OSS（字节不穿过应用进程）→ `POST /assets/{assetId}` 回桶里核实真实 key、多大、什么类型，落一行。另一条路 `POST /assets/import`：给外部地址 → 搬进桶里 → 落一行，`assetId` 按源地址算，同一个地址只搬一次。

- 登记之前 assetId 还不是一份素材，`GET /assets/{id}` 一律 404。登记端点没有请求体：key 由 assetId 派生、大小与类型从桶里读回来；签名时把 `Content-Type` 一起签进去。大小上限只在登记这一步卡；没被登记的对象按 `uploads/` 前缀清理。
- 行上存 object key，不存 URL。不做归属过滤，`creator_user_id` 只是查询维度与审计依据；外键用 restrict。
- 图片尺寸：直传信客户端在签名时报的宽高；转存自己量。需求单封面（`app/task_styles.py`）不经过登记表。
