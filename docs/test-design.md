# iclip-agent 测试设计

> 测试策略与测试点登记的事实源。命令入口见 [../AGENTS.md](../AGENTS.md)。

## §0 测试哲学（唯一编写规范）

测试的目的不是凑代码覆盖率，而是验证用户和系统的可见边界。

### 0.1 行为归层

每个行为只在**一个**层测试，选**最靠近用户可观察边界**的层：HTTP 状态码 + camelCase payload、事件序列、Postgres 行、文件产物。unit 层只收两类：纯函数逻辑，或 integration 层无法经济触达的分支。同一断言出现在两层即删除靠内的那份。

### 0.2 测试禁区 (Anti-patterns)

为了保持测试的生命力和可重构性，严禁以下行为：
- ⛔️ **禁止 import / monkeypatch 下划线私有符号**（棘轮基线登记，只降不升，当前为**空**）。
- ⛔️ **禁止调用录像断言**（断言结果，不断言过程；「某函数被以某参数调用过」不是行为）。
- ⛔️ **禁止框架 kwargs 快照**。**单点例外**：当调用形状本身就是契约时（引擎运行入口的调用形状），允许且仅允许一个单点契约测试承担。
- ⛔️ **禁止 prompt / 自然语言文本快照**（只断言结构，不断言措辞）。
- ⛔️ **禁止在 fake 里写生产逻辑**；fake 只做最小状态机。
- 边界用例必须映射到已登记的风险点，不做覆盖率驱动的凑数测试；发现测试违反本节规则时先删测试再补对层。

### 0.3 棘轮

棘轮基线是历史违规的豁免清单，只许减少、不许新增：`PRIVATE_IMPORT_BASELINE` 在架构测试中登记，初始为空，条目消失后必须同步从基线删除（防陈旧豁免）。

### 0.4 执行节奏

开发内环只跑被改 surface 的定向测试（按 §1 测试树目录与 §3 登记表定位对应用例）；提交前 `make check`；合入前 CI 全链。不在迭代中反复跑全量。

## §1 四层测试树结构

我们将测试从快到慢、从纯逻辑到依赖外部，分为以下四层：

```text
server/tests/
├── unit/                  # 纯逻辑 + 架构契约；无 I/O、无网络、无真实数据库
├── integration_no_llm/    # 默认集成门禁：使用真实 Postgres，但无真实 LLM / OSS / provider
├── integration_llm/       # 外部集成门禁：连通真实大模型进行对话或生成测试（当前无用例）
├── e2e_full/              # 外部门禁：全链路 Smoke Test（当前无用例）
└── helpers/               # 测试基建；不得命名为 test_*.py
```

- **Marker 自动注入**：`tests/conftest.py` 会根据上述目录结构自动为测试用例注入 pytest marker（例如 `unit` 或 `integration_no_llm`）。
- **Collection Contract**：如果 `tests/` 根目录或未定义的层级下出现了 `test_*.py`，`T-COLL-01` 这条单测会报错点名该文件。注意它是收集完成之后的断言失败，不是在收集阶段被拒收——这类文件同时也拿不到层级 marker，跑默认门禁时会被直接跳过。如果需要新增子目录，请先修改契约。
- **门禁定义**：
  - **默认门禁**：通过 `pytest -m "unit or integration_no_llm"` 运行。
  - **外部门禁**：通过 `make test-external` 运行（若缺少真实外部凭证则自动 skip，但**不得产生 fail**）。

## §2 Postgres 测试环境规则 (针对 integration_no_llm)

针对需要数据库的集成测试 (`integration_no_llm`)，数据库连接解析顺序如下：

1. 如果环境变量 `ICLIP_TEST_DATABASE_URL` 被显式设置，则直连该库（适用于本地已有库或 CI 容器）。
2. 若未设置环境变量，但本地 Docker 可用，则通过 Testcontainers 自动拉起一个一次性的 Postgres（Session 级别复用）。
3. 如果两者皆不可用，则直接 Skip。**注意：CI 必须提供 service container，因此 CI 上永远不允许出现静默 Skip**。

**注意：** 测试代码只准使用临时环境（scratch schema 或一次性容器），严禁执行诸如 `DROP` 之类的操作影响或破坏配置在运行中的业务库结构。

## §3 测试点登记表 (Verification Map)

随着系统演进，测试点登记表会持续增长。所有的具体测试点、验证行为与风险映射，均已抽离并统一登记在独立的文档中：
👉 **[test-registry.md](test-registry.md)**

## §4 已知不可测 / 人工清单

- SSO / PMS 真实环境联通性：人工验收（见 [../AGENTS.md](../AGENTS.md) §3 验证矩阵），自动化测试只打替身协议客户端。
- LLM 输出语义质量：不进自动化门禁，自动测试只断言协议与结构。
- cookie `Secure` / 反代 WS upgrade 等部署属性：部署检查表，人工。
