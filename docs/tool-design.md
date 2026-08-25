# iclip-agent 工具编写规范

> agent 工具模型面文本的唯一编写规范：工具 docstring 与给模型的错误消息（`ModelRetry`）。这些文字每轮请求都进模型上下文，所以只写能改变模型行为的内容。工具怎么装配见 [architecture.md](architecture.md)；代码注释不归本文管。

## §0 先分层：这句话该写在哪

写一句模型面文本之前先判断它属于哪一层。**放错层是最容易犯、也最难自己发现的错**——措辞怎么打磨都救不回来。

| 层 | 回答什么 | 落在哪 |
|---|---|---|
| **工具 docstring** | **这个工具是什么**：做什么、参数怎么给、上限多少、参数值从哪来、失败与退化是什么语义 | 工具函数的 docstring |
| **skill** | **怎么用这些工具**：什么场景走哪条链、几步接力、每步产出喂给谁、什么时候不走这条链 | `server/agents/skills/<名>/SKILL.md` |
| **capability 指引**（`get_instructions`） | 这组工具**自身**的语义，单个 docstring 装不下的那种 | 少用；没有就返回 `None` |

**指引里不许出现工具描述已经说过的话。** 它每轮请求都进上下文，重复一遍就是每轮都付一次钱，而模型照着它也做不出不同的动作。判据很直接：**指引里点到某个工具的名字，那句话多半该搬进那个工具的 docstring 或它的错误消息。** `workspace` 的指引因此只剩一句「这个工作区是什么、归谁」——「先列一遍再动手」进了 `list_files`，「改一段而不是整份重写」本来就在 `write_file` 和 `edit_file` 里，「撞上容量上限去删」是配额错误消息的收尾动作。

判据在 [architecture.md](architecture.md) §5：skill 是**流程知识**、判断标准与产出格式；capability 是一组类型化工具。所以「先拆片再取帧再出拼图再切开」这种接力顺序一律归 skill，工具 docstring 里不写。

点了另一个工具的名字，未必就越界，看它在回答哪个问题：

- ✅ **路由**——「这件事本工具不管，归 `X`」（`图像内容不随本工具返回；用 ReadMediaFile 读 url 看板`）。这是在划本工具的边界，属于「这个工具是什么」，也就是 §1 第 2 条。
- ✅ **前置条件**——「没有 `X` 的产物就用不了本工具」，通常出现在错误消息里，给的是一个可执行动作（§1 第 8 条）。
- ⛔️ **接力顺序**——「先用 `A`，再把结果喂给 `B`，然后 `C`」。这是流程知识，搬去 skill。

## §1 八条通行写法

下面每条都附一个业界 CLI agent 工具描述里的实例（原文保留，它本身就是证据）。

1. **第一行一句话说清干什么。**
   （`Read a text file from the local filesystem.` / `Perform exact replacements in existing files.`）

2. **写这个工具的适用与不适用范围。** 模型手上有一排相似工具，选错工具比用错参数更常见。注意与 §0 的界线：说清「这个工具管什么、不管什么」是它自己的事；「这一步之后该做什么」是 skill 的事。
   （`Do not `Glob`, `ls`, or otherwise pre-check known text file paths` / `Use `Grep` only when the task is to search for unknown content or locations` / `use `ReadMediaFile` for images or video`）

3. **写「什么时候不要用」和「什么时候不要重复用」。**
   （`**When NOT to use:** Single-shot answers that complete in one or two tool calls` / `Do not re-call this tool when nothing meaningful has changed since the last call` / `do not re-read solely to prove the write landed`）

4. **写并行与分批。** 默认行为是一轮一次串着调，要并行就得明说。
   （`When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.`）

5. **硬禁止用加重祈使句，不用商量语气。**
   （`DO NOT call Edit from memory, stale context, or a guessed `old_string`.` / `Write is NOT ALLOWED for incremental changes to existing files`）

6. **规则要带机械后果，不带设计理由。** 后果是模型能识别、能预判的事实；理由是给读代码的人的。
   （`A previous Edit can invalidate a later Edit's `old_string`, causing `old_string not found`. Read the file again before the next Edit.`）

7. **上限用数字说，并给一条出路。** 只说上限不给出路，模型撞上去就卡住。
   （`Returns up to {{ MAX_LINES }} lines or {{ MAX_BYTES_KB }} KB per call` + `Page larger files with `line_offset` (1-based start line) and `n_lines`.`）

8. **提前声明拒绝与错误语义；错误消息以一个可执行动作收尾。**
   （`Sensitive files ... are refused to protect secrets; do not attempt to read them.` / `old_string not found in {path}, the file contents may be out of date. Please use the Read Tool to reload the content.`）

`Args:` 每个参数一行，只写取值怎么给；类型、默认值、必填与否 schema 已经表达，不重复。

## §2 禁区

- ⛔️ **设计理由进模型面**。「为什么这么设计」模型看了做不出不同的动作。要写就写第 6 条那种机械后果。
- ⛔️ **复述 schema**。类型、默认值、必填与否不再用文字说一遍。
- ⛔️ **含糊的建议句**。「尽量」「建议」「最好」一律改祈使句：要么是规则，要么删掉。
- ⛔️ **把业务事实当工具属性写**。这次调用花多少钱、走的哪条计费渠道，模型据此做不出规则以外的动作。要约束的行为直接写成规则（「同一份需求不要重复调用」），别写价签。

同一条信息的两种写法：

- ⛔️ 「切格按图上真实的分隔带走，不是机械等分——生成出来的拼图常带外边框和不等宽的格间距。」（设计理由，模型无法据此行动）
- ✅ 「结果会说明是按网格线切的还是退回了等分；退回等分时先看一眼图再用。」（可执行的规则）

## §3 示例

取自 [capabilities/shot_video/capability.py](../server/src/iclip/capabilities/shot_video/capability.py) 的 `plan_shot_frames`：

    """从参考视频等间隔抽帧，按结构层级分板返回候选帧预览板。

    - 镜头起止时间戳与结构层级分组取自该视频的拆解文档；每秒取一帧，帧按时间
      戳落进覆盖它的镜头。
    - 一个结构层级一张预览板，每张候选帧左上角标注帧号，形如 S8-3（第 8 个镜
      头的第 3 个候选帧）。
    - 图像内容不随本工具返回；用 `ReadMediaFile` 读 url 看板，需要多板时在同一
      次回复中并行读取。
    - 同一视频与同一份拆解文档重复调用会直接复用既有结果，不重复抽帧。
    - 该视频尚未拆解、拆解文档读不出镜头时间戳、或时间戳超出视频时长时返回
      错误。

    Args:
        ctx: 框架给的运行上下文。
        video_url: 参考视频地址，逐字取自对话里给你的那个。
    """

对照 §1：第 1 条（首行一句话）、第 2 条（说清什么不由本工具返回、该用哪件工具去看）、第 3 条（同一视频同一份文档重复调用会复用，不重抽）、第 4 条（多板在同一次回复里并行读）、第 8 条（三类失败提前声明）。整段**零设计理由**：为什么每秒一帧、为什么按结构层级分板，模型知道了也做不出不同的动作。

也对照 §0：这里点了 `ReadMediaFile`，点的是**路由**——「图像内容不由我返回，去用它」，划的是本工具自己的边界。什么时候该拆片、拆完接着干什么、选出帧号之后怎么写 prompt，一个字都没有：那是接力顺序，归 skill。
