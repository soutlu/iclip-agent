# iclip-agent 测试设计

> 测试策略与覆盖的事实源；测试点随里程碑登记。命令入口见 [../AGENTS.md](../AGENTS.md)。

## §0 测试哲学（唯一编写规范）

### 0.1 行为归层

每个行为只在**一个**层测试，选**最靠近用户可观察边界**的层：HTTP 状态码 + camelCase payload、事件序列（M1 起）、Postgres 行、文件产物。unit 层只收两类：纯函数逻辑，或 integration 层无法经济触达的分支。同一断言出现在两层即删除靠内的那份。

### 0.2 禁止事项

- 禁 import / monkeypatch 下划线私有符号（棘轮基线登记，只降不升，当前为**空**）。
- 禁调用录像断言（断言结果，不断言过程；「某函数被以某参数调用过」不是行为）。
- 禁框架 kwargs 快照。**单点例外**：当调用形状本身就是契约时（引擎运行入口的调用形状，M1 起），允许且仅允许一个单点契约测试承担。
- 禁 prompt / 自然语言文本快照（只断言结构，不断言措辞）。
- 禁在 fake 里写生产逻辑；fake 只做最小状态机。
- 边界用例必须映射到已登记的风险点，不做覆盖率驱动的凑数测试；发现测试违反本节规则时先删测试再补对层。

### 0.3 棘轮

`PRIVATE_IMPORT_BASELINE` / `PRIVATE_SETATTR_BASELINE` 在架构测试中登记，初始为空、只降不升，条目消失后必须同步从基线删除（防陈旧豁免）。

### 0.4 执行节奏

开发内环只跑被改 surface 的定向测试（surface → 路径映射见 AGENTS.md §4）；提交前 `make check`；合入前 CI 全链。不在迭代中反复跑全量。

## §1 四层测试树

```text
server/tests/
├── unit/                  # 纯逻辑 + 架构契约；无 I/O、无网络、无数据库
├── integration_no_llm/    # 默认门禁：真实 Postgres，无真实 LLM / OSS / provider
├── integration_llm/       # 外部门禁：真实模型（M1 起启用）
├── e2e_full/              # 外部门禁：全链路 smoke（M2 起启用）
└── helpers/               # 测试基建；不得命名为 test_*.py
```

- marker 由 `tests/conftest.py` 按目录自动注入（`unit` / `integration_no_llm` / `integration_llm` / `e2e_full`）。
- **collection contract**：`tests/` 根或未知层级出现 `test_*.py` 即 collection 失败；新增子目录先改 contract。
- 默认门禁 = `pytest -m "unit or integration_no_llm"`；外部门禁 = `make test-external`（缺凭证自动 skip，**不得 fail**）。

## §2 Postgres 三环境规则

integration_no_llm 使用真实 Postgres，解析顺序：

1. `ICLIP_TEST_DATABASE_URL` 显式设置 → 直连（本地已有库 / CI service container）；
2. 未设置且本地 Docker 可用 → testcontainers 自动起一次性 Postgres（session 级复用）；
3. 两者皆无 → skip，**但 CI 必须提供 service container，因此 CI 永不静默 skip**（CI 工作流显式设置 `ICLIP_TEST_DATABASE_URL`）。

测试只准使用 scratch schema / 一次性容器，禁止 DROP 运行配置声明的业务 schema。

## §3 M0 测试点登记表

| ID | 层 | 行为 | 风险 |
|----|----|------|------|
| T-ARCH-01 | unit | tach 依赖图 + 框架围栏（pydantic_ai/fastapi/sqlalchemy/fastapi-users 各归其位，相对导入一并解析） | 分层腐蚀 |
| T-ARCH-02 | unit | 跨模块只准 import 对方 public.py；models/commands 只许 stdlib+common | 耦合扩散 |
| T-ARCH-03 | unit | 无静默 except fallback | 静默降级 |
| T-COLL-01 | unit | collection contract：越位测试文件被拒收；棘轮基线为空且无陈旧条目 | 测试树腐蚀 |
| T-CONFIG-01 | unit | 运行必需 env 缺失 → 加载/启动期报错并指向字段 | 静默降级 |
| T-CONFIG-02 | unit | YAML 未知字段 / 坏形状 → 拒绝 | 配置漂移 |
| T-RBAC-01 | unit | 角色→权限矩阵投影（admin/editor/viewer 三行全断言）；未知角色零权限 | 越权 |
| T-KEY-01 | unit | key 生成格式 `iclip_sk_`、哈希与前缀派生；授予集 ⊄ 属主权限 → 拒绝 | 凭证泄露/越权 |
| T-AUTH-01 | integration_no_llm | 注册（默认 viewer）→ 登录（204 + Set-Cookie）→ `GET /users/me`（{user:{...}} 信封、permissions 投影） | 主链路 |
| T-AUTH-02 | integration_no_llm | 未认证 401；登出清 cookie；username 或 email 均可登录 | 认证边界 |
| T-KEY-02 | integration_no_llm | 创建 key（明文仅一次）→ Bearer 调用受保护端点 → 吊销后 401 | 双主体主链路 |
| T-KEY-03 | integration_no_llm | 属主降权后，key 越出交集的调用 403；属主停用后 401 | key ⊆ 属主 |
| T-KEY-04 | integration_no_llm | DB 中无明文 token（只有哈希 + 前缀）；列表只返回前缀 | 凭证泄露 |
| T-SSO-01 | integration_no_llm | authorize 返回带 redirect_uri/_fromApp 的跳转 URL；SSO 关闭时整组路由 404 | SSO 契约 |
| T-SSO-02 | integration_no_llm | callback：verify → PMS 资料 → 首登建号（editor）→ Set-Cookie；再登复用同一账号并同步资料 | SSO 契约 |
| T-SSO-03 | integration_no_llm | PMS 失败 → callback 显式失败，不建号不发 cookie | 静默降级 |
| T-WS-01 | integration_no_llm | WS 握手 principal 解析：cookie（同源/白名单/非法 Origin 拒 1008）与 Bearer 各分支 | 双主体传输无关 |
| T-USERS-01 | integration_no_llm | `GET /users` / `PATCH /users/{id}` 仅 users:manage；改角色即时生效 | 越权 |
| T-MIG-01 | integration_no_llm | alembic upgrade head 于 scratch 环境成功；表结构与聚合元数据零漂移 | 迁移漂移 |
| T-ADMIN-01 | integration_no_llm | admin CLI set-role 直连 DB 提权首个 admin | 引导链路 |

## §4 已知不可测 / 人工清单

- SSO / PMS 真实环境联通性：人工验收（AGENTS.md §6），自动化测试只打 fake 协议客户端。
- LLM 输出语义质量：M1 起进入本节，自动测试只断言协议与结构。
- cookie `Secure` / 反代 WS upgrade 等部署属性：部署检查表，人工。
