# Pydantic AI 最新稳定版 `v2.35.0` 更新调研

> 调研日期：2026-08-25（America/Los_Angeles）；仅采用 Pydantic 官方文档、官方博客，以及 `pydantic/pydantic-ai` 官方 GitHub release 与 PR。

## 结论

截至本次调研，Pydantic AI 的最新稳定版是 **`v2.35.0`**，版本日期为 **2026-08-25**。GitHub 官方 API 返回 `draft=false`、`prerelease=false`，`published_at=2026-08-26T01:31:01Z`，即洛杉矶时间 **2026-08-25 18:31:01 PDT**；对应 release 页面也标记为 **Latest**。[GitHub 官方 API](https://api.github.com/repos/pydantic/pydantic-ai/releases/latest) · [`v2.35.0` release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.35.0)

这里把“稳定版”定义为官方仓库 `releases/latest` 选中的、同时不是 draft 或 prerelease 的 release，而不是简单取最高 tag。因此没有把 alpha、beta、RC 或未发布 tag 当成最新稳定版。该版本刚发布时，GitHub 的 release 列表与搜索索引曾短暂缓存为 `v2.34.0`；本结论以实时 API 和已标记 Latest 的具体 `v2.35.0` 页面为准。

`v2.35.0` 不是一次大型功能发布，而是一次有明确迁移影响的维护版：**统一 capability 运行时术语、修正 `TestModel` 的整数边界生成、降低 Temporal 指标默认导出频率，并修复显式空工具描述被 docstring 覆盖的问题**。官方 release 将其列为 2 项兼容性说明、1 项功能和 1 项 bug fix。[完整 release notes](https://github.com/pydantic/pydantic-ai/releases/tag/v2.35.0)

## `v2.35.0` 逐项变化

| 类别 | 变化 | 实际影响与迁移建议 | 一手来源 |
|---|---|---|---|
| 兼容性说明 | 废弃 `RunContext.capability_loaded` 与 `available_capability_ids`，改用 `capability_active` 与 `active_capability_ids`。 | 旧属性暂时保留兼容 shim，但会触发弃用路径；业务代码应尽快换成新名称。新术语准确表达“本步中 capability 的贡献是否生效”：always-on capability 从一开始就是 active，deferred capability 被 `load_capability` 加载后才 active。PR 还统一了工具的 `discovered`、`revealed`、`available` 与 capability 的 `loaded`、`active` 含义，并过滤历史里已不存在的 capability/tool 标识。 | [PR #7454](https://github.com/pydantic/pydantic-ai/pull/7454) |
| 兼容性说明 | `TestModel` 对双侧、含端点的整数区间，现在可以生成合法的 `maximum`。 | 以前 `Field(ge=2, le=5)` 的生成跨度按 `maximum - minimum` 计算，只可能得到 `2/3/4`；现在 `5` 也可达。对受影响 schema，非零 `seed` 的确定性结果可能变化，已有 snapshot 可能需要更新；`seed=0` 不变。若测试真正关心精确参数，官方建议输出值用 `custom_output_args`，function-tool 参数用 `FunctionModel`。 | [PR #7697](https://github.com/pydantic/pydantic-ai/pull/7697) |
| 功能 | Temporal + `LogfirePlugin` 的指标默认导出周期从继承 Temporal Core 的 1 秒改为 60 秒。 | 默认不再每秒导出一次 Temporal metrics；需要更高频或更低频时可覆写 `metric_periodicity`。也补充了通过自定义 `Runtime` 设置 `metrics=False` 来完全关闭指标的文档与测试。workflow 执行和 tracing 语义不变。 | [PR #7768](https://github.com/pydantic/pydantic-ai/pull/7768) |
| Bug fix | `Tool(description="")` 会保留显式空描述，不再回退到函数 docstring。 | `description=None` 或省略参数时仍从函数推导描述；只有明确传入空字符串时保持为空。这让调用方可以有意阻止 docstring 被发送到每次模型请求中，并使 `Tool(...)` 与本就保留空描述的 `Tool.from_schema(...)` 行为一致。 | [PR #7759](https://github.com/pydantic/pydantic-ai/pull/7759) |

### 升级时最值得检查的两处

1. 全局搜索 `capability_loaded` 与 `available_capability_ids`，改成 `capability_active` 与 `active_capability_ids`。这次仍有兼容 shim，但它们已经正式 deprecated。[弃用与语义表](https://github.com/pydantic/pydantic-ai/pull/7454)
2. 若测试用 `TestModel(seed=非零值)` 生成带双侧整数边界的结构化输出或工具参数，检查 snapshot 是否发生合法但不同的变化；这不是生产模型行为变化。[兼容性说明](https://github.com/pydantic/pydantic-ai/pull/7697)

## 最近值得关注的三个方向

下面是依据 `v2.33.0` 至 `v2.35.0` release、v2 官方公告和当前官方文档所作的归纳；“方向”是对多条官方事实的综合判断，不是官方 roadmap 承诺。

### 1. `Capability` 已成为框架的主要扩展边界

Pydantic AI v2 把 instructions、tools、lifecycle hooks、model settings 和模型选择组合到同一个可复用 `Capability` 中，官方文档明确称其为 **primary extension point**。第一方 Harness 则把 coder/researcher、文件系统、shell、planning、subagents、memory、context management、guardrails 等较高层能力做成可组合 capabilities；core 保持较小，Harness 允许更快迭代。[v2 官方公告](https://pydantic.dev/articles/pydantic-ai-v2) · [Capabilities 文档](https://pydantic.dev/docs/ai/capabilities/overview/) · [Pydantic AI Harness](https://pydantic.dev/docs/ai/harness/)

`v2.35.0` 对 active/loaded/available 术语的整理并非纯命名美化：它是在收紧 on-demand capability 与 tool search 的状态模型，避免“配置为 deferred”“已加载”“当前生效”“工具当前可调用”几种状态混为一谈。[PR #7454](https://github.com/pydantic/pydantic-ai/pull/7454) 前一版 `v2.34.0` 还修正了 `load_capability` 忽略 Agent 工具重试预算的问题，说明这条按需加载执行链正在持续硬化。[`v2.34.0` release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.34.0) · [PR #6937](https://github.com/pydantic/pydantic-ai/pull/6937)

### 2. 从“Agent loop”继续向可运行、可观测、可接 UI 的生产执行层推进

最近两个版本连续处理生产执行边界：`v2.34.0` 修复 UI 流取消时的陈旧 part 状态，以及 Vercel AI reasoning 历史在第二轮被 422 拒绝；`v2.35.0` 则把 Temporal + Logfire 的 metrics 默认导出周期从 1 秒调整为 60 秒，并允许覆写或关闭。[`v2.34.0` release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.34.0) · [UI 流取消修复](https://github.com/pydantic/pydantic-ai/pull/7675) · [Vercel AI reasoning 修复](https://github.com/pydantic/pydantic-ai/pull/7706) · [Temporal metrics 调整](https://github.com/pydantic/pydantic-ai/pull/7768) · [UI Event Streams 文档](https://pydantic.dev/docs/ai/integrations/ui/overview/)

这组变化表明，近期重点不仅是增加 Agent 能做什么，还包括让长运行任务、前端流式协议、取消、trace 与 metrics 在真实部署中保持一致和可控。

### 3. 持续扩充模型覆盖，同时用 profile 消除 provider/gateway 差异

官方模型层把 Model、Provider 与 Profile 分开：Model 封装 SDK，Provider 处理认证和连接，Profile 描述某个模型族的 schema、thinking、native tools 等能力；同一模型通过不同 gateway 调用时仍应解析到正确 profile。[Model Providers 文档](https://pydantic.dev/docs/ai/models/overview/)

最近 release 很能体现这一路线：`v2.34.0` 新增 Z.AI GLM-5.3 支持，并修复 Cerebras 参数转发、Vercel Gateway 下 Groq profile 丢失、Cohere 零参数工具调用、Bedrock DeepSeek R1 alias 等 provider/profile 差异；`v2.33.0` 则快速跟进 Anthropic 1.0.0 与 `httpx2` 的兼容变化。[`v2.34.0` release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.34.0) · [`v2.33.0` release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.33.0)

## 一句话判断

如果只关心最新版本：**`v2.35.0` 的主要价值是把 capability 状态语义和测试/运维边角进一步做实，而不是引入新的 Agent 顶层 API。** 如果在评估近期整体演进，则更重要的是三条连续主线：Capability/Harness 组合模型、生产执行与 UI/观测能力、以及跨模型提供商的 profile 一致性。
