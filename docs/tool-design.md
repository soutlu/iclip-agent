# Agent 工具编写规范

> 本文管工具的模型面文本与登记声明。装配机制见 [architecture.md](architecture.md)，业务事实见 [CONTEXT.md](CONTEXT.md)，声明面决策见 [ADR-0007](adr/0007-tool-declaration-surface.md)。

## 1. 文本归属

| 内容 | 落点 |
|---|---|
| 工具做什么、参数来源、适用范围、上限、重复调用和失败语义 | 工具 docstring |
| 何时选择工具、跨工具接力顺序、判断标准与产出格式 | `server/agents/skills/<名>/SKILL.md` 及其 references |
| 整组工具共有、单个 docstring 无法表达的语义 | capability 的 `get_instructions`；没有则返回 `None` |
| 本次失败后可以采取的动作 | 给模型的错误消息 |

同一条指引只放一处。capability 指引不重复工具描述；docstring 可以指出其他工具负责的边界或必需的前置产物，不编排跨工具流程。

## 2. 模型面写法

只写会改变模型动作的信息：

- 第一行用一句话说明工具做什么。
- 说明适用范围、何时不要调用、重复调用是否复用结果；涉及并行或分批时明确规则。
- 规则用明确指令，并写出模型可预期的结果；不使用「尽量」「最好」等含糊建议。
- 上限用数字表达，同时说明超限后的可执行动作。
- 提前说明拒绝、失败与退化语义；错误消息给出修正参数、读取产物或停止重试等下一步。
- `Args:` 只补充参数如何取值；schema 已表达的类型、默认值、必填性不复述。

不放设计理由，不复述业务背景或计费细节。需要约束重复付费调用时，直接说明禁止重复的条件和失败后的动作。

例如，「结果会说明是否退回等分；退回等分时查看图片后再使用」是可执行规则；解释拼图为什么出现不等宽间距不属于工具指引。完整工具示例直接阅读 [ShotVideoToolset.plan_shot_frames](../server/src/iclip/capabilities/shot_video/toolset.py)，不在文档复制 docstring。

## 3. 登记与范围校验

工具登记时声明输入范围、审批条件和展示信息。当前工具使用 `Tool(..., args_validator=...)` 注册到 toolset 或 capability；参考 [workspace](../server/src/iclip/capabilities/workspace/capability.py)、[shot_video](../server/src/iclip/capabilities/shot_video/toolset.py) 与 [skill references](../server/src/iclip/harness/skills.py)。

- 素材来源、素材类型、已挂载 skill 等单工具范围规则放 `args_validator`，不散入工具执行逻辑。共用素材校验使用 [harness/materials.py](../server/src/iclip/harness/materials.py) 的 `require_http`、`require_material`。
- `ModelRetry` 表示参数可以修正；`ToolFailed` 表示本次失败、不要重试；`ApprovalRequired(metadata=...)` 表示需要审批，metadata 提供原因。
- 范围验证与审批不替代授权。属主隔离仍按运行 deps 在工具和存储层执行；文件存在性、存储安全与业务状态校验保留在对应执行边界。
- Agent 能看见哪些工具由挂载声明决定。不应拥有的工具不挂载；需要按运行条件过滤工具表时使用 `PrepareTools`。
- 跨工具统一规则有实际需求时，集中在一个 capability 的 `before_tool_execute`；不为尚不存在的规则创建策略层。

## 4. 输出与展示

给模型的单次文本返回不超过 50,000 字符；超出时在源头写入工作区，返回路径与摘要。`video_parser_md` 使用这一方式。

给用户的结构化结果放 `ToolReturn(return_value=给模型的内容, metadata=给用户的内容)`。metadata 随工具结果持久化，不进入模型上下文；媒体结果使用 `{"items": [{"url": ..., "caption": ...}]}`，对应 `view="media_grid"`。

每件工具由所属 capability 提供 display 映射，组合根合并后供实时与历史共同使用。`kind` 只取 [display 协议](../server/src/iclip/platform/transcript/display.py) 已有值，不自行扩展；无法生成专用展示时使用 `generic`。前端按协议的 `view` 选择结果渲染器，不按工具名判断。
