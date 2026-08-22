# ADR-0001: 架构地基——三环分层、Agent 配置化、DB-based 运行、双主体与技术栈

- 状态：已接受（2026-08-18）

## 决策

### 1. 三环分层

`harness/`（通用 agent 内核，不认识业务）⊥ `domains/`（六边形业务模块，不认识 pydantic_ai）⊥ `capabilities/`（唯一同时认识两者的适配环）；`app/` 为唯一组合根。业务适配走类型化工具（Pydantic 参数模型即业务 schema），打进 Capability 能力包，内核零改动。

围栏由 `tach.toml` + `tests/unit/architecture/` 机械强制：框架关在其环内，跨模块只准 import 对方 `public.py`。

### 2. Agent 配置化

Agent 由**声明式配置**定义，不在代码里散落硬编码：一个运行目标 = 模型 alias × prompt 资产 × 能力包集合 × 运行参数 profile。配置在启动期一次性装配并冻结，运行期只按 ID 读取；会话建立时记录所用目标与其配置版本，配置热更不改变既有会话的语义。

客户端永远不能指定 provider、model 或 prompt——它只能引用一个已声明的目标 ID。

### 3. DB-based 运行

Agent 在代码/配置里初始化，**运行事实全部落 Postgres**：运行血缘、逐步事件、可续跑的消息历史快照、工具副作用账。进程内存只承载当前连接与当前运行，绝不承载跨 worker 正确性；续跑与恢复靠读库，不靠内存缓冲。

运行持久化复用官方 `pydantic_ai_harness` StepPersistence 的存储形状，只自研 Postgres 后端（实现官方异步协议），表结构不做本地改造——升级即映射，不是重设计。

### 4. 双主体身份

一个 `Principal`（kind ∈ {user, api_key}）在唯一中间件点解析：cookie `iclip_session`（JWT，每 hop 验签一次）或 `Authorization: Bearer iclip_sk_...`（SHA-256 哈希查表）。解析器是传输无关 dependency，同时服务 HTTP、浏览器 WS 握手（cookie + Origin 校验）与机器 WS 握手（Bearer 头）。

API key：`iclip_sk_` + 32 字节 urlsafe base64；只存哈希与展示前缀，明文仅创建响应一次；全部事实行记录 `user_id + api_key_id?` 供审计。权限模型见 [ADR-0002](0002-unified-permission-model.md)（权限集合是唯一授权货币）。

服务账号：已考虑、暂缓——当前形态为「专用 user 行持 key」，需要独立生命周期时再升格。

### 5. 技术栈选型

| 选型 | 理由 |
|---|---|
| Python 3.13 + uv | pydantic-ai 官方支持 3.10–3.14 |
| FastAPI + fastapi-users | 账号生命周期 + OAuth 关联是验证过的强项；「自己写」指业务代码，不禁用成熟库 |
| pydantic-settings（YAML 源） | 配置声明集中一处；`*_env` 间接引用与交叉引用校验为薄校验层，密钥只在环境变量 |
| SQLAlchemy 2 async + Alembic + asyncpg | 标准组合；表结构只经人工 `alembic upgrade head` 演进，启动期不建表 |
| pyright strict + ruff + tach | 静态门禁自第一行代码闭合 |
| structlog | 结构化日志，级别来自配置 |
| **不引入 Redis / 独立队列服务** | 决定性理由是**事务性入队**：任务行与业务事实在同一个 Postgres 事务提交，是「唯一事实源」不变量的直接延伸；Redis broker 需要 outbox 才能等价——即手搓一个 Postgres 队列还多养一个有状态服务。全部跨 worker 正确性由 Postgres 承载 |

### 6. 引擎升级纪律

pydantic-ai 以 lockfile 精确 pin，生产绝不使用宽松版本区间；每个上游 release 走一个升级 PR，门禁全绿才可合，目标滞后上游 ≤1–2 个版本。`pydantic-ai-harness`（0.x，官方明示 minor 可破 API）pin 到精确版本，且只准 `harness/` import、经再导出使用，把生态 API 抖动关在一个模块里。

### 7. 数据

全新数据库、不做任何数据迁移。直接后果（已接受）：全部用户重新注册 / 重新 SSO，首个 root 重新引导。

### 8. 刻意保留的自研组件

“不要重复造轮子”的另一面约定——以下**不是轮子**，不得以该指令为由将其替换为第三方库：

1. **显式组合根**：模式本身不是框架；引入 DI 容器（如 dependency-injector）才是非常规选择。
2. **Principal 解析器 + api_keys 表**：对于双主体系统没有被广泛采用的现成包；自研的实现面很小，仅包含一张表与一个 dependency。
3. **StepPersistence 的 Postgres 后端**：官方仅提供内存、文件、SQLite 与 MongoDB 后端，因此 PG 后端必须自研（实现官方协议，不魔改表结构）。

## 后果

- 扩展路径被分层钉死：新业务能力 = 领域模块 + 能力包 + 配置声明，内核零改动。
- 运行正确性由数据库持有，不由进程持有：多 worker 是配置问题，不是重写问题。
- 无 Redis、无独立队列服务的运维面。
