# ADR-0007: 工具的声明面

- 状态：已接受（2026-09-02）
- **[ADR-0005](0005-transcript-protocol.md)**：transcript 协议照抄 kimi，工具帧上的 `display` 与 `view` 字段由它定义；本文定这两个字段由谁产出、取值范围。
- **[ADR-0006](0006-durable-runs.md)** 决策 4：审批是 run 的结束点，`awaiting` 机制不变；本文定「哪次调用要审批」怎么声明。
- **[ADR-0001](0001-architecture-foundations.md)** §6：pydantic-ai 与 harness 的接口只经 `harness/` 再导出；本文全部建立在两者的公开接口上。

## 背景

工具的边界规则散在工具体里：`ReadMediaFile` 体内三道检查（是不是 HTTP 地址、是不是这段对话里出现过的地址、是不是图），`generate_shot_frames` 对每张参考图再做一遍，`get_skill_reference` 体内一句 `if skill not in granted` 划访问边界。这些规则界面看不到，审批卡拿不到，每加一件工具重写一遍。

工具卡怎么画由 `platform/transcript/display.py` 一张按工具名查的中心表决定，能力包新加一件工具要改平台文件，不改就画成「工具调用」且不报错。工具返回给模型的东西就是界面能拿到的全部：`generate_shot_frames` 返回的帧地址用户看不到。

pydantic-ai 2.37 已有与此对应的公开接口：`FunctionToolset.add_function(..., args_validator=)`（schema 校验后、执行前跑，可抛 `ModelRetry` / `ToolFailed` / `ApprovalRequired`）、`requires_approval`、`Capability(defer_loading=True)` 按需 capability、`PrepareTools`、`AbstractCapability.before_tool_execute`、`ToolReturn(metadata=)`（`metadata` 不发给模型、随 `ToolReturnPart` 落库）；harness 有 `ToolGuardrail` 与 `ToolOutputLimits`。kimi 的工具合同（`resolveExecution` 声明 accesses / approvalRule / display，`execute` 只执行，权限由策略链集中判定）作为参考实践，不移植。

## 决策

### 1. 一件工具登记时给出完整的声明面

工具经 `add_function` 登记时一并声明：范围规则（`args_validator`）、是否要审批（`requires_approval` 或验证器抛 `ApprovalRequired`）、界面画法（display）、给人看的结果形状（`ToolReturn.metadata`）。工具体只做本职，不判断范围、不判断权限。

### 2. 范围规则写在 `args_validator` 里

- 单工具的范围规则一律是验证器，不写在工具体里。共用的验证器放 `harness/`：`materials_only(kind)`（地址必须是这段对话里出现过、且声明为该种类的，挂 `ReadMediaFile` 的 `url` 与出图工具的参考图参数）、`skill_granted`（挂 `get_skill_reference`）。
- 验证器抛 `ModelRetry` 表示「参数能改」，抛 `ToolFailed` 表示「这次不行、别重试」，抛 `ApprovalRequired(metadata=...)` 表示「要人点头」；`metadata` 随 `DeferredToolRequests` 带出去给审批卡。
- 属主隔离不在验证器里：审批与验证都不是授权边界，按 `deps` 里的身份做的数据隔离留在工具体与存储层。

### 3. 跨工具的规则只有一个落点

跨工具的统一规则（例如某件工具只准主 agent 调）出现时，放进**一个**常驻 capability 的 `before_tool_execute`；需要检测器或结果侧过滤时换 harness `ToolGuardrail`。当前没有这样的规则，不建这个 capability。付费工具不设审批门槛，pro 渠道不问。

### 4. 可见性靠声明，不靠运行期拒绝

- skill 专属的工具（`get_skill_reference`）放进该 skill 的按需 capability：每个 skill 是一个 `Capability(id=skill 名, description, instructions=SKILL.md 正文, tools=[...], defer_loading=True)`，工具随 skill 加载才出现在模型的工具表里。`harness/skills.py` 自己按 SKILL.md 造它，不再经 harness `Skills`。
- 子代理不该有的工具不挂，而不是挂上再回错。按运行期条件过滤工具表时用 `PrepareTools`。

### 5. 界面画法归工具所有者

- 每个 capability 自带「工具名 → 参数 → display」的表，与工具同文件。`platform/transcript/display.py` 只留 display 的类型与合表协议；组合根把各能力的表合成一份，同一实例递给实时（`projector.py`）与历史（`from_messages.py`）两条路。
- display 的 `kind` 只取 kimi `packages/protocol/src/display.ts` 里已有的：`file_io`、`search`、`url_fetch`、`skill_call`、`agent_call`、`generic`。不自造 kind。
- 帧上的 `view`（协议已有）由服务端给出，前端按它选渲染器，不认工具名；给不出就不给，前端走 generic。

### 6. 给人看的结果走 `ToolReturn.metadata`

- 需要给人看结构化结果的工具返回 `ToolReturn(return_value=给模型的原样, metadata=给人看的形状)`。`metadata` 不进模型上下文，随 `ToolReturnPart` 落库，实时与历史两条路读同一个字段，原样放进工具帧。
- 媒体类结果的形状固定为 `{"items": [{"url": ..., "caption": ...}]}`，`view="media_grid"`。

### 7. 模型面输出的上限

- 一次工具返回给模型的文本不超过 50,000 字符。超出的在源头处理：写进工作区，返回路径与摘要。`video_parser_md` 是这个写法的现成例子。
- harness `ToolOutputLimits` 只作兜底，配置为 `Spill(then=Truncate())`，spill store 必须是 Postgres 实现（官方两个方法的 `OverflowStore` 协议），不用默认的本地盘。当前十三件工具都在源头限界，不挂它。

### 8. `ReadMediaFile` 归 workspace

- `ReadMediaFile` 是通用工具，挂在 workspace 能力上；名字、`url` 参数、「只收对话里出现过的地址」不变。
- 参照 kimi 的 `read-media-file` 加 `region {x, y, width, height}`（原图像素坐标，经 OSS `image/crop` 参数裁切）与 `full_resolution`（不挂缩放参数）；结果的媒体 tag 里带一段系统摘要：mime、字节数、原图宽高、这次是原样 / 降采样 / 裁切 / 全分辨率交付、坐标按原图算。超单图字节上限时报错并指向 `region`，不重试原图。
- 原图信息问 OSS 的 `image/info`；workspace 为此多一个窄端口 `MediaProbe.info(url)`，组合根用现有的 httpx 客户端实现。仍只读图。

### 9. 进度暂缓

工具执行中的进度（帧上的 `progress`）等第二类长任务出现再决策。

## 取舍

- **不抄 kimi 的 `accesses` 并行调度。** 本仓工具之间没有文件写冲突，`edit_file` 已带版本号。
- **不抄 kimi 的敏感文件表与权限模式（manual / yolo / auto）。** 没有本地文件系统；权限模式属于用户设置层，等审批卡上线再看。
- **不为一条不存在的规则建策略 capability。** 决策 3 只定落点。
- **接受 skill 加载那一轮工具表变化会打断一次提示缓存前缀。** 走 OpenAI 兼容端点没有原生的工具增量披露通道；一段对话里 skill 只加载一次。
- **接受 `metadata` 让快照变大。** 它只装给人看的形状（地址与标题），不装字节。
- **接受审批卡与工具卡共用一份 display。** 这是决策 5 的直接结果，不另设审批的展示合同。
- **工具名、参数、给模型的返回、错误消息、SKILL.md 正文全程不变。** 它们是 skill 的契约。
