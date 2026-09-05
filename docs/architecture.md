# 后端架构

> 本文说明模块职责、装配与运行机制。业务术语和不变量见 [CONTEXT.md](CONTEXT.md)，接口约定见 [contract/conventions.md](../contract/conventions.md)，开发流程见 [AGENTS.md](../AGENTS.md)，决策与取舍见 [ADR](adr/)。

## 1. 模块职责

后端是 FastAPI 模块化单体，Agent 引擎使用 PydanticAI 与 Pydantic AI Harness。`app/` 是唯一组合根：读取配置、创建连接池、装配模块、连接模块间的协议并管理生命周期。

以下路径均相对 `server/src/iclip/`。

| 位置 | 职责 |
|---|---|
| `domains/` | 业务用例、领域模型、HTTP 入口及存储适配；不依赖 Agent 引擎 |
| `harness/` | 通用 Agent 装配、运行驱动、消息持久化、上下文压缩与 transcript 投影；不解释业务身份和业务规则 |
| `capabilities/` | 面向模型的类型化工具，连接 Agent 引擎与业务能力 |
| `platform/` | 共用技术协议及适配器：存储、素材台账、HTTP 错误映射、transcript 类型 |
| `common/` | 领域错误分类 |
| `config/` | 配置声明、环境变量定义与启动期解析 |
| `app/` | 组合根及跨模块适配 |
| `main.py` / `asgi.py` | CLI / ASGI 入口 |

依赖图与框架引用边界以 [tach.toml](../server/tach.toml) 和 [架构测试](../server/tests/unit/architecture/test_architecture.py) 为准。业务模块按职责拆文件，不要求每个模块凑齐固定文件模板。

能力包之间不互相 import。确需共享的技术协议下沉到 `platform/`，由组合根注入同一个实例；协议随实际调用需求定义，不提前建立抽象层。

存储适配跟随使用其协议的模块：业务自有表放对应模块的 `infra_sql.py`，外部只读库用独立适配器；官方 StepPersistence 的 Postgres 实现在 `harness/step_store_pg.py`。数据库 engine 只由组合根创建。

## 2. 配置与装配

| 权威入口 | 内容 |
|---|---|
| [configs/config.yaml](../server/configs/config.yaml) | 运行参数、模型命名表与模型端点 |
| [config/models.py](../server/src/iclip/config/models.py) | 配置字段、默认值、环境变量名、功能开关与依赖校验 |
| [agents/agents.yaml](../server/agents/agents.yaml) | Agent ID、spec、模型引用、skill、capability 与子代理声明 |
| [config/agents.py](../server/src/iclip/config/agents.py) | 声明与资产路径解析 |
| [app/bootstrap.py](../server/src/iclip/app/bootstrap.py) | 资源创建、模块装配、路由挂载与生命周期 |

运行配置与 Agent 声明在启动期加载、校验并装配。配置文件路径分别由 `CONFIG_FILE`、`AGENTS_FILE` 指定；CLI 的 `--config`、`--agents` 设置这两个入口。依赖服务的连接信息与凭证由环境变量提供；模型凭证由 `models.*.api_key_env` 指向环境变量。可选功能的启用条件与缺失依赖处理集中在 `resolve_settings()`，不在业务模块中重新读取配置。

Agent 声明文件必须存在；不启用 Agent 时写 `agent: {}`。`spec` 必须指向现存文件，文件内容可以为空；同目录的 `instructions.md` 自动加载。主 Agent ID 来自声明键，子 Agent 名称来自 spec 所在目录名；声明的名称、模型覆盖 spec 对应字段，关闭磁盘自动扫描。

skill 与 capability 都按 Agent 显式挂载，子代理不继承主代理的挂载。skill 正文由 Harness 按需加载，reference 由随库挂载的 `get_skill_reference` 读取。capability 的实例和挂载依赖集中在 [app/capability_table.py](../server/src/iclip/app/capability_table.py)，工具声明规则见 [tool-design.md](tool-design.md)。

模型适配集中在 [harness/models.py](../server/src/iclip/harness/models.py)，同名模型复用实例。provider 选择交给官方 `infer_model`；`api: responses` 使用本仓的 Responses 子类。模型参数转换不进入业务模块或工具。

lifespan 启动运行驱动与已启用的生成队列；关停时先停止后台任务并等待运行终态落库，再关闭 HTTP 客户端和本应用持有的连接池。启动不建表，迁移单独执行。

## 3. 身份与模块协作

HTTP 与 WebSocket 由 `PrincipalMiddleware` 统一解析身份。中间件只解析，授权由入口与业务用例执行；WebSocket 入口另行校验 Origin，订阅时校验对话可见性。SSO callback 完成验证、账号关联与本地 cookie 签发；配置 PMS 时同步用户资料，失败即终止登录。后续普通请求不再调用 SSO/PMS。

运行通过 `AgentRunDeps` 向工具传递可信主体与对话 ID，业务含义和权限约束见 [CONTEXT.md](CONTEXT.md)。harness 只传递 deps，不解包业务字段；工具所需服务由组合根闭包注入，不放进 deps。客户端 state 不作为运行身份或服务来源。

跨模块协作在组合根适配。例如：产品资料与对象存储实现需求单的款式快照端口；合集元信息接入对话侧栏；工作区文件和素材台账接入对话的派生数据端口。模块只使用自身声明的协议，不自行创建其他模块的客户端或仓库。

## 4. 持久化与迁移

| 数据 | 实现位置 |
|---|---|
| `iclip` 业务表 | 各领域模块的 `infra_sql.py` |
| `agent_runtime` 运行历史与快照 | `harness/step_store_pg.py`，实现官方 StepStore 协议 |
| `agent_runtime` prompt 队列、运行关联与审批记录 | `harness/jobs.py` |
| `agent_runtime` 工作区与对话素材台账 | `platform/file_store/pg.py`、`platform/material_ledger/pg.py` |
| `public` 生成任务调度表 | procrastinate；DDL 随 Alembic 迁移维护 |
| 产品资料与爆款视频外部库 | 对应领域的 `catalog_pg.py`，独立连接池设置会话级只读 |

表结构只经 [Alembic 迁移](../server/migrations/versions/) 演进，命令见 [AGENTS.md](../AGENTS.md)。新增表与迁移的对账范围、人工核对要求见 [测试规范](test-design.md#3-postgres-测试环境)。

## 5. 运行、记录与订阅

Agent 运行由 [ConversationRunner](../server/src/iclip/harness/transcript/runner.py) 驱动，与发起请求的连接生命周期分离。持久化机制见 [ADR-0006](adr/0006-durable-runs.md)：

- prompt 先进入 Postgres 队列；数据库约束保证同一对话的运行互斥，租约、心跳与清扫处理认领和中断恢复。
- StepPersistence 保存消息历史与可续跑快照；恢复读取持久记录。停止运行使用框架取消入口，等待终态落库。
- 审批结束当前 run，决定持久化后以新 run 续跑，仍属于同一轮；审批工具只挂顶层 Agent。
- 生成任务另由 procrastinate 的提交、轮询队列驱动，业务状态写回生成任务表；机制见 [ADR-0004](adr/0004-generation-queue-in-postgres.md)。

transcript 是运行记录的投影。历史由 `from_messages` 从持久消息生成，实时由 `projector` 从引擎事件生成；两条路径必须得到相同的编号和结构，共用工具 display 注册表。上下文压缩在完整历史中插入 `CompactionPart`，发送模型时从最后一条边界计算窗口，不删除原始消息，见 [ADR-0011](adr/0011-context-compaction.md)。

实时投影与连接注册表在每个 worker 的内存中，快照持久化后才移交该轮实时状态。当前没有跨 worker 广播：订阅落到其他 worker 时无法收到该运行的实时事件。多 worker 部署必须把这一限制纳入连接路由设计。

WebSocket 订阅、活动状态和文件变更帧的对外约定见 [contract/conventions.md](../contract/conventions.md)，本文不维护第二份帧与端点清单。

## 6. 日志

[app/logging.py](../server/src/iclip/app/logging.py) 统一配置 structlog 与标准库日志的渲染链。请求和 WebSocket 连接的 `request_id`、`principal` 通过 contextvars 传递；级别、格式由运行配置决定。业务日志写法和第三方噪音处理见 [AGENTS.md](../AGENTS.md)。
