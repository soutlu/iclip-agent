# ADR-0001: 架构地基——三环分层、Agent 配置化、DB-based 运行、双主体与技术栈

- 状态：已接受（2026-08-18）

## 决策

### 1. 三环分层

`harness/`（通用 agent 内核，不认识业务）⊥ `domains/`（六边形业务模块，不认识 pydantic_ai）⊥ `capabilities/`（唯一同时认识两者的适配环）；`app/` 为唯一组合根。业务适配走类型化工具（Pydantic 参数模型即业务 schema），打进 Capability 能力包，内核零改动。

围栏由 `tach.toml` + `tests/unit/architecture/` 机械强制：框架关在其环内，跨模块只准 import 对方 `public.py`。

### 2. Agent 配置化

Agent 由**声明式配置**定义：官方 spec、模型引用、prompt 资产、能力与子代理声明在启动期装配并冻结，运行期按目标 ID 读取。配置入口与覆盖规则见 [architecture.md](../architecture.md#2-配置与装配)。

发起 Agent 运行时，客户端只能引用已声明的目标 ID，不能覆盖其 provider、model 或系统指令。媒体生成请求的模型与渠道是另一份业务合同。

### 3. DB-based 运行

Agent 在代码/配置里初始化，**运行事实全部落 Postgres**：运行血缘、逐步事件、可续跑的消息历史快照、工具副作用账。进程内存只承载当前连接与当前运行，绝不承载跨 worker 正确性；续跑与恢复靠读库，不靠内存缓冲。

运行持久化复用官方 `pydantic_ai_harness` StepPersistence 的存储形状，只自研 Postgres 后端（实现官方异步协议），表结构不做本地改造——升级即映射，不是重设计。

### 4. 双主体身份

浏览器会话与机器 API key 统一解析为 `Principal`，HTTP 与 WebSocket 共用解析器；下游只消费可信主体。权限模型与审计约束见 [ADR-0002](0002-unified-permission-model.md)，传输约定见 [跨端合同](../../contract/conventions.md#2-双主体认证-dual-principals)。

### 5. 技术栈选型

| 选型 | 理由 |
|---|---|
| Python + uv | 项目版本要求由 `pyproject.toml` 声明，依赖解析结果写入 lockfile |
| FastAPI + fastapi-users | 账号生命周期 + OAuth 关联是验证过的强项；「自己写」指业务代码，不禁用成熟库 |
| pydantic-settings（YAML 源） | 配置声明集中一处；`*_env` 间接引用与交叉引用校验为薄校验层，密钥只在环境变量 |
| SQLAlchemy 2 async + Alembic + asyncpg | 标准组合；表结构只经人工 `alembic upgrade head` 演进，启动期不建表 |
| pyright strict + ruff + tach | 静态门禁自第一行代码闭合 |
| structlog | 结构化日志：事件 + 字段；标准库来源经 ProcessorFormatter 走同一条链；级别与格式来自配置 |
| **不引入 Redis / 独立队列服务** | 全部跨 worker 正确性由 Postgres 承载；Redis broker 要做到等价还得加一层 outbox。生成队列由 [ADR-0004](0004-generation-queue-in-postgres.md) 的 procrastinate 承载，表仍在 Postgres 里 |

### 6. 引擎升级纪律

引擎依赖的精确版本由 [uv.lock](../../server/uv.lock) 固定，CI 使用 `uv sync --locked`。升级时同步依赖声明与 lockfile，并验证装配、持久化和 transcript 契约；不把安装时临时解析出的版本当成已验证版本。引擎的 import 与再导出边界由 [架构测试](../../server/tests/unit/architecture/test_architecture.py) 维护。

### 7. 刻意保留的自研组件

“不要重复造轮子”的另一面约定——以下**不是轮子**，不得以该指令为由将其替换为第三方库：

1. **显式组合根**：模式本身不是框架；引入 DI 容器（如 dependency-injector）才是非常规选择。
2. **Principal 解析器 + api_keys 表**：封装本系统的双主体身份与显式授权规则。
3. **StepPersistence 的 Postgres 后端**：实现官方存储协议，让运行事实进入本系统的 Postgres；不修改协议语义。

## 后果

- 扩展路径被分层钉死：新业务能力 = 领域模块 + 能力包 + 配置声明，内核零改动。
- 运行认领与恢复由数据库约束；实时订阅仍有 worker 内存边界，限制见 [architecture.md](../architecture.md#5-运行记录与订阅)。
