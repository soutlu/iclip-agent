# iclip-agent 测试点登记表 (Test Registry)

> 本文档是 `docs/test-design.md` 中测试策略的具体执行映射表。随着系统演进，所有新增的自动化测试点和对应的边界风险都应在此登记。
> 实际已收集、已执行的用例以测试树目录与 CI 结果为准，不得仅凭本表宣称某项逻辑已经验证。

## 自动化测试矩阵

| ID | 层 (Layer) | 期望断言行为 (Behavior) | 预防风险 (Risk) |
|----|----|------|------|
| T-ARCH-01 | unit | tach 依赖图（相对导入同样解析）+ 框架围栏（pydantic_ai/pydantic_ai_harness/ag_ui/fastapi/sqlalchemy/fastapi-users 各归其位） | 分层腐蚀 |
| T-ARCH-02 | unit | 跨模块只准 import 对方 public.py；models/commands 只许 stdlib+common | 耦合扩散 |
| T-ARCH-03 | unit | 无静默 except fallback | 静默降级 |
| T-COLL-01 | unit | collection contract：越位测试文件被拒收；棘轮基线为空且无陈旧条目 | 测试树腐蚀 |
| T-CONFIG-01 | unit | 运行必需 env 缺失 → 加载/启动期报错并指向字段 | 静默降级 |
| T-CONFIG-02 | unit | YAML 未知字段 / 坏形状 → 拒绝 | 配置漂移 |
| T-AGENTCFG-01 | unit | `agents.yaml` **缺失即报错**（不降级成空注册表）；文件存在但内容空 / `agent: {}` → 空注册表；`spec` 解析为绝对路径、同目录 `instructions.md` 按约定挂上（缺则 None） | 静默降级 |
| T-AGENTCFG-03 | unit | agent 条目缺 `model` 即拒收（没有默认模型）；主从可各自指定模型 | 悄悄用了别的模型 |
| T-AGENTCFG-02 | unit | 未知字段（段内与顶层）、非 mapping 文档 → 拒绝；主/子 `spec` 文件不存在 → 启动期报错并指向声明位置 | 配置漂移 / 静默降级 |
| T-AGENTASM-01 | unit | 装配以 `name=<agent id>` 覆盖 spec 的 `name`（两个 id 指向同名 spec 仍可区分）；子 agent name 取自目录名 | 运行身份歧义 |
| T-AGENTASM-02 | unit | `instructions.md` 并入模型实际收到的指令；空白文件等价于「无提示词」，不注入空指令 | 提示词静默丢失/污染 |
| T-AGENTASM-03 | unit | 声明了 subagent 即挂上 `delegate_task` 且下属名进提示词 | 装配期冻结失效 |
| T-AGENTASM-04 | unit | 未注册 id → NotFound、请求体不合协议 → ValidationFailed，且两者都在返回事件流之前抛出 | 错误在流中途才暴露 |
| T-AGENTASM-05 | unit | 协议流路径真的落库：主 agent 与被派活下属各留一条 run，会话 id 取自请求体、`parent_run_id` 自动指向主 run | 运行事实只活在进程内存 |
| T-MODEL-01 | unit | 命名模型装配：端点与 key 来自配置（含只收 api_key 的 provider 走 openai_client）；`api: responses` 显式分派且厂商 profile 不丢；有专属模型类的 provider（Ollama 等）不被拍平；未知 provider、responses 用在非 OpenAI 兼容 provider 上均装配期报错 | 静默走错端点 / 丢厂商适配 |
| T-MODELCFG-01 | unit | `models` 段：键名即模型名（`model` 字段只在起名时覆盖）；`api` 默认 chat、非法值即拒；声明了某模型但其 `api_key_env` 为空即启动报错 | 静默降级 |
| T-AGENTASM-06 | unit | agent / 子 agent 引用未声明的模型名即装配期报错；spec 里的 `model:` 被声明覆盖 | 模型声明双写打架 |
| T-AGENTAPI-01 | unit | `/agents/{id}/chat`：无主体 401、缺 `agent:run` 403、非 JSON content-type 415（且未派发运行）、未注册 id 404、坏 body 422、正常 200 + `text/event-stream` 首帧 | 越权 / CSRF / 错误映射 |
| T-AGENTAPI-02 | unit | `OPTIONS /agents/{id}/chat` 返 204 且不含任何 `Access-Control-Allow-*` 头 | CSRF 防线被削弱 |
| T-RBAC-01 | unit | 预置角色投影（root/editor/viewer 全断言，root=全量计算）；有效权限=角色并集∪直接授权；未知角色零权限；`api_keys:issue` 仅 root | 越权 |
| T-KEY-01 | unit | key 生成格式 `iclip_sk_`、哈希与前缀派生；签发需 `api_keys:issue`；授予集 ⊄ 签发者权限 → 拒绝；key 主体不能签发 key | 凭证泄露/越权 |
| T-AUTH-01 | integration_no_llm | 注册（默认 viewer）→ 登录（204 + Set-Cookie）→ `GET /users/me`（{user:{...}} 信封、permissions 投影） | 主链路 |
| T-AUTH-02 | integration_no_llm | 未认证 401；登出清 cookie；username 或 email 均可登录 | 认证边界 |
| T-KEY-02 | integration_no_llm | 创建 key（明文仅一次）→ Bearer 调用受保护端点 → 吊销后 401 | 双主体主链路 |
| T-KEY-03 | integration_no_llm | key 有效权限=显式授权集，属主角色变化不影响；属主停用后 401 | key 权限语义 |
| T-KEY-04 | integration_no_llm | DB 中无明文 token（只有哈希 + 前缀）；列表只返回前缀 | 凭证泄露 |
| T-SSO-01 | integration_no_llm | authorize 返回带 redirect_uri/_fromApp 的跳转 URL；SSO 关闭时整组路由 404 | SSO 契约 |
| T-SSO-02 | integration_no_llm | callback：verify → PMS 资料 → 首登建号（editor）→ Set-Cookie；再登复用同一账号并同步资料 | SSO 契约 |
| T-SSO-03 | integration_no_llm | PMS 失败 → callback 显式失败，不建号不发 cookie | 静默降级 |
| T-SSO-04 | integration_no_llm | 同邮箱既有账号首次 SSO 登录：只关联身份，不重置 roles/直接授权（资料字段照常同步） | 身份提供方改写授权 |
| T-WS-01 | integration_no_llm | WS 握手 principal 解析：cookie（同源/白名单/非法 Origin 拒 1008）与 Bearer 各分支 | 双主体传输无关 |
| T-USERS-01 | integration_no_llm | `GET /users` / `PATCH /users/{id}` 仅 users:manage；调整角色/直接授权即时生效；不能改自己的授权或停用自己 | 越权 |
| T-MIG-01 | integration_no_llm | alembic upgrade head 于 scratch 环境成功；`iclip` schema 下的表结构与 identity 的 ORM 元数据零漂移（`agent_runtime` 的五张表不在断言内） | 迁移漂移 |
| T-STORE-01 | integration_no_llm | PG step store 满足官方 `StepStore` / `MediaStore` 协议；register 单发、list_runs 排序与过滤、快照 complete/interrupted 读门、保留集裁剪、tool_effects upsert | 与官方语义漂移 |
| T-STORE-02 | integration_no_llm | 真实 Agent（FunctionModel）挂官方 StepPersistence 跑通：运行/事件/工具账落库，续跑历史与 `all_messages()` 解析成 JSON 后结构一致 | 运行历史不可续 |
| T-STORE-03 | integration_no_llm | 消息负载无损往返：含 `NUL(\u0000)` 转义的文本、≥64KiB 媒体外置与还原 | 存储层静默损坏 |
| T-AGENTRUN-01 | integration_no_llm | 真实 app + 真实用户：匿名 401、viewer 403、editor 跑通 `test` 模型 200 流；未注册 id 404、非 JSON 415、坏 body 422、OPTIONS 不放行 | 双主体与 agent 运行面的联动 |
| T-AGENTRUN-02 | integration_no_llm | 完整 HTTP 路径跑一次运行后，`agent_runtime.runs` 有对应会话的 run（id 前缀为 agent id），`agent_runtime.events` 首帧为 `run_started` | 运行事实只活在进程内存 |
| T-ADMIN-01 | integration_no_llm | root 引导：`ICLIP_ROOT_EMAIL` SSO 登录即持有 root；CLI set-roles 直连 DB（非 SSO 场景） | 引导链路 |
