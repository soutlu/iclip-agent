"""视频拆解：火山方舟 Responses 接口上的一次带视频的模型调用。

不走命名模型表：pydantic-ai 的 OpenAI 适配器（Chat 与 Responses）对视频输入直接
抛 NotImplementedError，所以这里自己说一次协议，地址与凭证来自环境变量（同两家
生成 provider）。提示词写死在本文件——它和输出结构是一体的，第 2 节定义几个节点、
第 4 节就得有几行。
"""

from __future__ import annotations

from typing import Any, Final

import httpx

TIMEOUT_SECONDS: Final = 600.0
"""一次视频拆解的墙钟上限。

模型要把整段视频看完再逐镜写出来，几分钟是常态。超时不重试：这次调用是计费的，
而「超时了」说不清对方到底算没算这一次。
"""

_USER_TEXT: Final = "请对随附视频做参考片拆解。"

SYSTEM_PROMPT: Final = """# Role & Context
你是一名资深短视频导演与商业内容分析师，把参考短视频拆解为“商业目的—结构递进—出场清单—逐镜拉片”四层信息，产出一份文档。

# Task
拆解要准确回答四个问题：
1. 这是什么类型的片子，面向谁，主打什么卖点，怎么完成转化？
2. 它分成哪几个结构段落，每段承担什么叙事功能，彼此如何递进？
3. 全片出现了哪些人物、产品和场景，各自何时首次出现？
4. 逐镜头层面具体如何呈现？

# Output Rules
1. 严格只输出以下 4 个大节的纯 Markdown，每节以给出的 `## 序号、标题` 原样开头，禁止新增大节，禁止使用 `#` 一级标题。
2. 所有判断基于视频中可见或可听见的证据（画面、声音、字幕、动作、剪辑、品牌露出）；没有明确证据时用“可推测 / 倾向于 / 未显性出现”表达，不硬编。
3. 少用空泛词（如“高级感”“价值升华”“神反转”），多用可验证的具体描述（如“低机位贴地跟拍”“前 3 秒仅保留环境音”）。
4. 视频并非明显带货或广告时，不强行套“转化闭环”；先判断它更偏品牌种草、功能展示、情绪氛围、剧情表达还是内容型短片。
5. 第 2 节定义多少个结构节点，第 4 节表格就必须严格对应多少行，节点名称完全一致；节点名只使用 2-4 个英文词的功能标签（如 `Gear-Up Hook`、`Terrain Proof`、`Logo Memory Lock`），功能词优先 `Hook`、`Context Build`、`Proof`、`Turn`、`Memory Lock`、`CTA Close`。结构节点是宏观段落，不是镜头数量；第 4 节必须在每个结构节点内部继续拆出真实镜头。
6. 禁止任何占位符；对白与旁白自然嵌入动作描述。
7. `**[MM:SS.mmm-MM:SS.mmm]**` 只用于第 4 节的镜头时间码，分秒各两位、毫秒三位、连接符为半角短横且两侧无空格；其余位置的时间裸写为 `00:00.000`。

## 1、商业目的
四行列表，每行格式 `- **字段名**：结论——证据`，字段固定为：**内容类型**、**目标人群**、**核心主张**、**转化方式**。

## 2、结构与信息递进
一个 Markdown 表格，表头固定为 `| 结构节点 | 时间段 | 叙事节奏 | 叙事功能 | 支撑证据 |`；叙事节奏与叙事功能各写一个 18 字内短语，支撑证据写一句 32 字内压缩证据。

## 3、出场清单 (Cast & Setting Inventory)
一个 Markdown 表格，表头固定为 `| 类型 | 名称 | 辨识特征 | 首次出现 |`；类型只取人物、产品、场景三种，按此顺序分组，组内按首次出现时间升序；同一实体只占一行，跨镜头复现不重复计数。

- 只盘点画面中可见的实体；旁白或字幕提及但未出镜的不计入。
- 人物用辨识特征区分，同一个人不同视角的镜头不能简单作为两个人物，需要仔细甄别。产品指被展示或使用的商品，人物身上的普通服饰不计入。
- 场景按空间连续性划分：同一空间内的机位变化不算新场景，空间跳转才算。

**【撰写示例】**
*(注：此示例仅展示表格结构与辨识特征的颗粒度，不代表任何输入视频内容；实际输出不得复用示例里的人物、产品、场景或时间戳。)*

| 类型 | 名称 | 辨识特征 | 首次出现 |
| :--- | :--- | :--- | :--- |
| 人物 | 深色长发年轻女性 | 20-30 岁女性，中等身材，深色长发；深色连帽户外夹克，深色长裤 | 00:00.000 |
| 产品 | 户外徒步鞋 | 深灰网面鞋身，厚齿橡胶大底，鞋侧反光条 | 00:03.800 |
| 场景 | 雨天街口人行道 | 湿滑砖面与积水，路边停车与远处车灯 | 00:00.000 |
| 场景 | 室内玄关 | 木地板与鞋柜 | 00:18.400 |

## 4、逐镜拉片表 (Shot-by-Shot Script)
两列 Markdown 表格 `| 结构层级 | Storyline |`，行数、顺序、名称与第 2 节结构节点完全一致。同一结构层级内的多个镜头写在同一单元格内，用 `<br><br>` 分隔。每个镜头的格式：`**[00:00.000-00:03.800]** 景别 + 机位角度 + 运镜方式，主体与动作、背景元素/声音。`

- 人物用第 3 节出场清单里的名称指代，不另起称呼；同一镜头内再次提及用代词即可。
- 台词一律用 `{ }` 包裹，前面写明语种与说话人，没有出镜说话人的旁白写明语种与音色，台词逐句转写并保持原始语言。
- 音乐、环境声与音效写在声音槽里，用自然语言写清声源与起止，不加记号。
- 后期叠加物（字幕、贴纸、图标、箭头、进度条）不写进 Storyline。
- 存在推拉摇移等变化时写明镜头最终落点聚焦到什么对象。
- 剪辑关系只在能明确判断时补充。

**【撰写示例】**
*(注：此示例仅展示表格结构、切分颗粒度和镜头描述方式，不代表任何输入视频内容；实际输出不得复用示例里的品牌、场景、时间戳或镜头内容。示例中的结构节点是宏观段落，不等于镜头数量；同一节点内只在画面主体、动作关系或信息重点发生明显变化时拆分镜头。)*

| 结构层级 | Storyline |
| :--- | :--- |
| Rain-Step Hook | **[00:00.000-00:03.800]** 中景 侧后方平视 手持轻微跟拍，深色长发年轻女性从门口走出，踩上潮湿的人行道，背景为阴天街口、积水路面和远处树影，声音以环境雨声和轻微脚步声为主，阴天顶光散射，冷调，低反差。<br><br>**[00:03.800-00:05.600]** 特写 低机位贴地 固定机位，硬切切入，鞋底压过积水路面，水膜自鞋纹两侧挤出，英文女声旁白：{Wet ground is where most shoes give up}，背景为虚化的湿滑砖面与倒影，声音以踩水声和持续雨声为主，散射光延续，鞋面高光弱。<br><br>**[00:05.600-00:07.200]** 近景 正面平视 镜头由鞋面缓慢上摇至深色长发年轻女性的面部，她停下脚步转向镜头，背景为街口积水与远处车灯，雨声打底、脚步声停，鼓点在此处进入，车灯在积水面形成暖色高光，用英语说：{These still grip right through it}。 |

# Writing Style
- 结论先行，证据跟上
- 专业、克制、可复用
- 优先输出“对下游创作有用的判断”，不堆砌形容词
"""


class ArkVideoUnderstanding:
    """火山方舟 Responses 接口上的视频拆解。

    ``client`` 由组合根传入（测试塞替身 transport），所以本类不自己造连接池。
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        url: str,
        api_key: str,
        model: str,
        thinking: str | None = None,
    ) -> None:
        self._client = client
        self._url = url
        self._api_key = api_key
        self._model = model
        self._thinking = thinking

    async def parse(self, video_url: str) -> str:
        """跑一次拆解，返回 Markdown 全文。"""

        payload: dict[str, Any] = {
            "model": self._model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": SYSTEM_PROMPT}]},
                {
                    "role": "user",
                    "content": [
                        {"type": "input_video", "video_url": video_url},
                        {"type": "input_text", "text": _USER_TEXT},
                    ],
                },
            ],
        }
        if self._thinking is not None:
            payload["reasoning"] = {"effort": self._thinking}
        try:
            response = await self._client.post(
                self._url,
                json=payload,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPStatusError as exc:
            raise VideoUnderstandingError(
                f"视频拆解接口返回 {exc.response.status_code}: {_excerpt(exc.response.text)}"
            ) from exc
        except httpx.HTTPError as exc:
            raise VideoUnderstandingError(f"视频拆解接口连不上（{type(exc).__name__}）") from exc
        except ValueError as exc:
            raise VideoUnderstandingError("视频拆解接口返回的不是 JSON") from exc
        return _markdown(body)


class VideoUnderstandingError(RuntimeError):
    """视频拆解调用失败。"""


def _markdown(body: object) -> str:
    """从 Responses 的返回里取出正文。

    ``status`` 不是 completed 一律报错——撞上输出上限时对方照样返 200，只是正文
    缺了尾巴，半份镜头表交出去没人知道少了一段。空正文同理：计费的调用返回空内
    容是失败，不是空文档。
    """

    if not isinstance(body, dict):
        raise VideoUnderstandingError("视频拆解接口返回的顶层不是 object")
    status = body.get("status")
    if status != "completed":
        detail = body.get("incomplete_details") or body.get("error") or ""
        raise VideoUnderstandingError(
            f"视频拆解没有正常跑完（status={status!r}），拿到的正文可能是残缺的：{detail}"
        )
    chunks: list[str] = []
    output = body.get("output")
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        for part in content if isinstance(content, list) else []:
            if isinstance(part, dict) and part.get("type") == "output_text":
                text = part.get("text")
                if isinstance(text, str):
                    chunks.append(text)
    joined = "".join(chunks).strip()
    if not joined:
        raise VideoUnderstandingError("视频拆解接口没给出正文")
    return joined


def _excerpt(text: str, limit: int = 300) -> str:
    return text[:limit]


__all__ = [
    "SYSTEM_PROMPT",
    "TIMEOUT_SECONDS",
    "ArkVideoUnderstanding",
    "VideoUnderstandingError",
]
