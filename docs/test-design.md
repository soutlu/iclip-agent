# iclip-agent 测试设计

> 命令入口见 [../AGENTS.md](../AGENTS.md)。

## §0 编写规则

### 0.1 行为归层

每个行为只在一个层测试，选最靠近用户可观察边界的层：HTTP 状态码 + camelCase payload、事件序列、Postgres 行、文件产物。unit 层只收两类：纯函数逻辑，或 integration 层无法经济触达的分支。同一断言出现在两层即删除靠内的那份。

### 0.2 禁区

- 不 import / monkeypatch 下划线私有符号。豁免清单 `PRIVATE_IMPORT_BASELINE` 在架构测试中登记，当前为空，只减不增。
- 不做调用录像断言：断言结果，不断言「某函数被以某参数调用过」。
- 不做框架 kwargs 快照。唯一例外：调用形状本身就是契约时（引擎运行入口），允许且仅允许一个单点契约测试。
- 不做 prompt / 自然语言文本快照：只断言结构，不断言措辞。
- 不在 fake 里写生产逻辑；fake 只做最小状态机。
- 发现测试违反本节规则时先删测试再补对层。

## §1 四层测试树

```text
server/tests/
├── unit/                  # 纯逻辑 + 架构契约；无 I/O、无网络、无真实数据库
├── integration_no_llm/    # 默认集成层：真实 Postgres，无真实 LLM / OSS / provider
├── integration_llm/       # 连通真实大模型
├── e2e_full/              # 全链路
└── helpers/               # 测试基建；不得命名为 test_*.py
```

`tests/conftest.py` 按目录自动注入 pytest marker；放错位置的 `test_*.py` 由架构单测报错点名。新增子目录先改契约。默认测试集为 `unit or integration_no_llm`（`make test`）；外部层由 `make test-external` 运行，缺凭证时 skip，不得 fail。

## §2 Postgres / Redis 测试环境

`integration_no_llm` 的数据库连接解析顺序：

1. 环境变量 `TEST_DATABASE_URL` 已设置 → 直连该库。
2. 未设置但本地 Docker 可用 → Testcontainers 拉起一次性 Postgres（Session 级复用）。
3. 两者皆不可用 → skip。CI 必须提供 service container，不允许 skip。

Redis 同一顺序（`TEST_REDIS_URL` > Testcontainers > skip），只有声明了 agent 的测试会请求它。

测试代码只使用临时环境（scratch schema 或一次性容器），不对运行中的业务库执行 `DROP` 等破坏性操作。

## §3 不进自动化的项目

- SSO / PMS 真实环境联通性：人工验收（见 [../AGENTS.md](../AGENTS.md) §3），自动化只打替身协议客户端。
- LLM 输出语义质量：自动测试只断言协议与结构。
- cookie `Secure`、反代 WS upgrade 等部署属性：部署检查表。
- 「客户端断开」：httpx 的 ASGITransport 会缓冲完整响应再交出，测不出读一半就断；要验真断开须起真服务器（见 `test_run_detached.py`）。
