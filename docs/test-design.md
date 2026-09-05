# 后端测试规范

> 命令入口与交付检查见 [AGENTS.md](../AGENTS.md)，前端测试见 [web/AGENTS.md](../web/AGENTS.md)。

## 1. 按行为选择测试层

优先验证用户可观察的结果或稳定契约：HTTP 状态与 payload、事件序列、持久化结果、文件产物。每个行为选一个主要测试层；同一断言在两层重复时保留靠近可观察边界的一份。unit 用于纯逻辑、进程内契约，或集成层无法经济触达的分支。

| `server/tests/` 下的目录 | 验证范围 |
|---|---|
| `unit/` | 纯逻辑、配置与引擎装配等进程内契约；可用临时文件和模型替身，不连接真实数据库或外部服务 |
| `integration_no_llm/` | 真实 Postgres、应用装配、HTTP/WS 与存储往返；LLM、OSS、provider 使用替身 |
| `integration_llm/` | 真实模型的协议与结构 |
| `e2e_full/` | 依赖真实外部服务的全链路 |
| `helpers/` | 共用测试基建，不放测试用例 |

marker 由 [tests/conftest.py](../server/tests/conftest.py) 按目录注入；测试树和私有符号导入由 [集合契约测试](../server/tests/unit/architecture/test_collection_contract.py) 检查。新增顶层测试层时同时更新这些入口和 [pyproject.toml](../server/pyproject.toml)，普通子目录不需要修改分层契约。

## 2. 断言与替身

- 断言结果，不记录并断言内部调用过程；不 import 或 monkeypatch 生产代码的下划线私有符号。
- 不对框架 kwargs 做快照。调用形状本身是稳定契约时，可以用一个集中的契约测试覆盖。
- 不对 prompt 或自然语言措辞做快照；只验证所需结构与行为。
- fake 只实现测试所需的最小状态，不复制生产业务逻辑。
- 调整不合层的测试时，将有效行为覆盖迁移到合适层，再删除重复或依赖实现细节的断言。

## 3. Postgres 测试环境

[integration_no_llm/conftest.py](../server/tests/integration_no_llm/conftest.py) 按以下顺序提供数据库：

1. `TEST_DATABASE_URL` 非空时使用指定测试库。
2. 否则由 Testcontainers 启动一次性 Postgres，测试会话内复用。
3. 两者都不可用时，本地数据库测试跳过；报告结果时必须说明跳过范围。

`TEST_DATABASE_URL` 必须指向专用、可清理的测试数据库。夹具会执行迁移并清空测试表，不能指向开发或生产业务库。数据库安全边界见 [AGENTS.md](../AGENTS.md)。

CI 使用明确配置的 Postgres service container；连接失败应报错，不能依赖本地跳过路径。真实外部服务测试缺凭证时可以跳过；凭证齐备后的连接、协议或业务失败不得伪装成缺凭证。

新增 `iclip` 自有表时，把模块元数据纳入 [迁移对账测试](../server/tests/integration_no_llm/bootstrap/test_migrations.py) 的 `_MODULE_METADATA`。该测试只比较表名与列名集合；列类型、索引、约束，以及 `agent_runtime` 和 procrastinate 表的迁移需另行核对。

## 4. 验证边界

- SSO/PMS 自动化使用协议替身；接入变更还需按 [AGENTS.md](../AGENTS.md) 完成真实登录回调验收。
- LLM 自动化验证协议与结构，输出语义质量单独评估。
- cookie `Secure`、反向代理 WebSocket upgrade 等属性在实际部署链路验收。
- 连接断开后的行为需要真实传输边界验证；不能把 `httpx.ASGITransport` 的完整缓冲响应当作中途断连测试。
