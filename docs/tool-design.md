# iclip-agent 工具编写规范

> agent 工具模型面文本的唯一编写规范：工具 docstring 与给模型的错误消息（`ModelRetry`）。这些文字每轮请求都进模型上下文，所以只写能改变模型行为的内容。工具怎么装配见 [architecture.md](architecture.md)；代码注释不归本文管。

## §0 先分层：这句话该写在哪

写一句模型面文本之前先判断它属于哪一层。**放错层是最容易犯、也最难自己发现的错**——措辞怎么打磨都救不回来。

| 层 | 回答什么 | 落在哪 |
|---|---|---|
| **工具 docstring** | **这个工具是什么**：做什么、参数怎么给、上限多少、参数值从哪来、失败与退化是什么语义 | 工具函数的 docstring |
| **skill** | **怎么用这些工具**：什么场景走哪条链、几步接力、每步产出喂给谁、什么时候不走这条链 | `server/agents/skills/<名>/SKILL.md` |
| **capability 指引**（`get_instructions`） | 这组工具**自身**的语义，单个 docstring 装不下的那种 | 少用；没有就返回 `None` |

判据在 [architecture.md](architecture.md) §5：skill 是**流程知识**、判断标准与产出格式；capability 是一组类型化工具。所以「先拆片再取帧再出拼图再切开」这种接力顺序一律归 skill，工具 docstring 里不写。

一条实用的分辨法：这句话**点了另一个工具的名字**，多半就是流程知识，该搬去 skill。例外是这个工具自身的适用范围（「只对网格拼图用」），那仍属于「这个工具是什么」。

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

取自 [capabilities/shot_video/capability.py](../server/src/iclip/capabilities/shot_video/capability.py) 的 `generate_image`：

    """生成一张图，返回它的地址。

    - 同一份需求不要重复调用——每次调用都会重新生成一张，不会返回上次的结果。
      出的图不满意就改 prompt 再调。
    - 参考图地址逐字取自工具结果或对话，不要自己构造。
    - 出图要几分钟，调用会阻塞等到有结果。超时返回的不是「没生成」——那次可能
      还在后台跑，不要马上重发。

    Args:
        ctx: 框架给的运行上下文。
        prompt: 画面描述。
        aspect_ratio: 画幅，如 ``9:16`` / ``16:9`` / ``1:1``。
        resolution: 出图档位，``1k`` / ``2k`` / ``4k``。
        reference_image_urls: 参考图地址；留空即纯文生图。
    """

对照 §1：第 6 条（重复调用的机械后果是重新生成一张，不是复用）、第 8 条（超时不等于没生成，所以不要马上重发）；参考图那条是 provenance，规则贴着它约束的参数放。

也对照 §0：这里**一个别的工具名字都没有**。「出拼图再切开」「参考图从哪一步来」都是接力顺序，归 skill；这份 docstring 只回答「`generate_image` 是什么」。
