# Qwen、Gemini 与豆包视频输入及 FPS 调研

> 调研日期：2026-08-29（America/Los_Angeles）；仅采用阿里云百炼、Google、火山引擎官方文档以及厂商官方模型卡。

## 结论

用户所写的 `qwen-omini 3.5` 应为 **Qwen3.5-Omni**，百炼当前 HTTP 模型 ID 是 `qwen3.5-omni-plus` 和 `qwen3.5-omni-flash`，另有带 `-realtime` 的 WebSocket 版本。用户所写的 `qwen3.8` 则不是一个可直接调用的唯一模型 ID，而是一个模型系列；能否输入视频要看具体 ID。

| 模型 ID / 系列 | 能否直接输入视频 | 官方声明的输入模态 | Hosted HTTP 的 FPS 结论 |
|---|---|---|---|
| `qwen3.5-omni-plus`、`qwen3.5-omni-flash` | **可以**；支持视频文件或预抽帧图片列表，并能同时理解视频中的画面与音频 | Text、Image、Video、Audio | 百炼通用 OpenAI 兼容 API 将 `fps` 定义为 `[0.1, 10]`，默认 `2.0`；Qwen-Omni 的官方视频 Token 估算代码也使用 `FPS = 2`。模型页另写的“720P（1 FPS）”是能力/容量描述，不是 HTTP 默认值。 |
| `qwen3.8-max` | **可以** | Image、Text、Video | 官方视频理解示例明确使用 `fps: 2`；视觉理解指南声明范围 `[0.1, 10]`、默认 `2.0`。 |
| `qwen3.8-flash` | **可以** | Image、Text、Video | 同属百炼视觉理解模型，适用同一 Hosted HTTP `fps` 规则：范围 `[0.1, 10]`、默认 `2.0`。 |
| `qwen3.8-27b` | **可以** | Image、Text、Video | 百炼 Hosted HTTP 适用同一规则；若自行部署，Qwen 官方模型卡也写明默认 `fps=2`，可在 vLLM 的 `mm_processor_kwargs` 中调整。 |
| `qwen3.8-2.4t-a95b` | **不可以** | Text | 没有视频输入，因此 FPS 不适用。 |

对应一手来源：[`qwen3.5-omni-plus` 模型页](https://help.aliyun.com/zh/model-studio/qwen3-5-omni-plus) · [`qwen3.5-omni-flash` 模型页](https://help.aliyun.com/zh/model-studio/qwen3-5-omni-flash) · [`qwen3.8-max` 模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-max) · [`qwen3.8-flash` 模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-flash) · [`qwen3.8-27b` 模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-27b) · [`qwen3.8-2.4t-a95b` 模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-2-4t-a95b)

## FPS 的准确含义

百炼的[图像与视频理解指南](https://help.aliyun.com/zh/model-studio/vision/)说明，视频文件不是逐帧全部送入模型，而是先抽取帧序列：

- `fps` 表示每秒抽取多少帧，即每隔 `1 / fps` 秒抽一帧。
- Hosted HTTP 取值范围为 **`0.1` 到 `10` FPS**，默认 **`2.0` FPS**。
- 高速运动内容适合提高 FPS；长视频或画面变化较少时适合降低 FPS。
- 若按 FPS 计算的帧数超过模型的帧数上限，服务会在上限内均匀抽帧。因此“设置 2 FPS”不保证很长的视频最终仍保持有效 2 FPS。
- 输入已经抽好的图片列表时，`fps` 主要用于告诉模型相邻图片对应的时间间隔，方便事件定位和时序理解。

同一指南以 `qwen3.8-max` 为例，直接上传视频文件时显式传入 `"fps": 2`。百炼的[OpenAI 兼容 Chat API 参考](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)也给出相同的 `[0.1, 10]`、默认 `2.0` 规则。

## 为什么 Qwen3.5-Omni 文档里同时出现 1 FPS 和 2 FPS

这三个数字的语境不同，不能混为一个“固定采样率”：

1. **HTTP API 默认值：2 FPS。** OpenAI 兼容 API 把视频输入的 `fps` 默认值定义为 `2.0`；[Qwen-Omni 用户指南](https://help.aliyun.com/zh/model-studio/qwen-omni)的官方视频 Token 估算代码也设置 `FPS = 2`，并为 Qwen3.5-Omni 设置最多抽取 2048 帧。
2. **模型页的 1 FPS：能力描述使用的配置。** `qwen3.5-omni-plus` 与 `qwen3.5-omni-flash` 模型页写的是“超过 400 秒的 720P（1 FPS）音视频理解与对话”。这里的 1 FPS 修饰该容量/能力描述，页面没有把它声明为 Hosted HTTP 的默认采样值。
3. **Realtime 的 1 FPS：官方建议。** [Qwen-Omni Realtime 文档](https://www.alibabacloud.com/help/zh/model-studio/realtime)明确说实时视频通过抽帧输入，**建议 1 帧/秒**。这是 WebSocket 实时会话的建议发送速率，不是 HTTP 文件上传的默认值。

另外，OpenAI 兼容 API 参考对 Qwen3.5-Omni 明确写了 `fps` 可用于告知相邻帧的时间间隔；其“控制服务端视频文件抽帧频率”的适用模型注释仍只点名 Qwen-VL、QVQ 和 MiniMax。结合 Qwen-Omni 的 `FPS = 2` 估算代码，可以确定其默认处理基准是 2 FPS；若业务要求服务端必须严格按自定义 FPS 抽帧，应对所用地域和具体快照做一次实测，不应把模型页的 1 FPS 当作固定值。

## Qwen3.8 的版本差异

“Qwen3.8 都支持视频”是不准确的：

- `qwen3.8-max`、`qwen3.8-flash` 与 `qwen3.8-27b` 的百炼模型能力表都包含 `Video` 输入，因此可解析视频画面。[Qwen3.8 官方仓库](https://github.com/QwenLM/Qwen3.8)也把 27B 列为 Qwen3.8 开放权重模型；[官方 27B 模型卡](https://huggingface.co/Qwen/Qwen3.8-27B)提供视频输入示例，自部署默认 `fps=2`，并注明当前通过 `extra_body` 自定义采样只在 vLLM 路径支持。
- `qwen3.8-2.4t-a95b` 的百炼模型能力表只列 `Text` 输入；[Qwen 官方 ModelScope 模型卡](https://www.modelscope.cn/models/Qwen/Qwen3.8-2.4T-A95B)也把它描述为 text-only，因此不能直接解析视频。
- Qwen3.8-Max/Flash/27B 的能力表没有 `Audio` 输入。相较之下，Qwen3.5-Omni 明确包含 `Audio`，且百炼 API 文档明确说明 Qwen-Omni 能理解视频文件中的视觉与音频。因此需要同时理解对白、音乐或环境声时，应选 Qwen3.5-Omni；只需画面理解时，可选支持视频的 Qwen3.8 变体。

## 可直接给使用方的简短答案

**如果你说的是 `qwen3.5-omni-plus/flash` 与 `qwen3.8-max/flash/27b`，两边都能解析视频；百炼 HTTP API 的抽帧默认是 2 FPS，可配置范围是 0.1–10 FPS。Qwen3.5-Omni 文档里的 1 FPS 是 720P 能力描述或 Realtime 建议，不是 HTTP 默认。若你指的是 `qwen3.8-2.4t-a95b`，它是纯文本模型，不能解析视频。**

## Gemini

Gemini 可以直接接收视频文件、内嵌视频数据、Cloud Storage 文件及公开视频 URL，并联合处理视觉流与音轨。Google 的[视频理解指南](https://ai.google.dev/gemini-api/docs/video-understanding)给出的常规视觉采样率是 **1 FPS**；File API 同样按 1 FPS 处理视频，并按 1 Kbps、单声道处理音频，每秒添加时间戳。

- `generateContent` 的 `videoMetadata.fps` 默认是 **1.0**，允许范围是 **`0 < fps <= 24`**，还可指定起止时间。[GenerateContent `VideoMetadata` 参考](https://ai.google.dev/api/generate-content#VideoMetadata)
- Gemini Developer API 当前推荐的 Interactions API 尚不支持 `video_metadata`，因此当前不能指定具体 FPS，只使用服务端处理策略。[Interactions API 限制](https://ai.google.dev/gemini-api/docs/interactions-overview)
- Vertex AI `generateContent` 仍支持自定义 `videoMetadata.fps`，默认和范围同样为 1.0 与 `(0, 24]`。[Vertex AI `VideoMetadata` 参考](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rpc/google.cloud.aiplatform.v1#videometadata)
- Live API 是独立口径：客户端发送 JPEG/PNG 视频帧，最高 **1 FPS**。[Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

因此，面向使用方最稳妥的说法是：**Gemini 能解析视频画面和音轨，普通上传默认按 1 FPS 处理；只有支持 `videoMetadata` 的 `generateContent` 接口可将采样率显式设为大于 1，最高 24 FPS。**

## 豆包 / 火山方舟

火山方舟的豆包 Seed 多模态模型支持直接输入视频。Seed 2.0 Pro、Lite、Mini 的多模态版本均可理解视频画面；官方[视频理解文档](https://www.volcengine.com/docs/82379/1895586?lang=zh)对方舟直接视频输入定义的 `fps` 默认值是 **1.0**，允许范围为 **`0.2–5` FPS**。

- `fps` 表示每秒均匀抽取的画面数；Seed 2.0 及后续模型默认至少保留 16 帧，最多 1280 帧。超出上限时会在整段视频中均匀抽帧，所以长视频的最终有效 FPS 可能低于请求值。
- 可确认联合理解视频内嵌音轨的是 `doubao-seed-2-0-lite-260428` 与 `doubao-seed-2-0-mini-260428`；官方[音频理解与视频内嵌音频输入文档](https://www.volcengine.com/docs/82379/2377589?lang=zh)说明服务会自动抽取音轨，可分析语音内容、语义及情绪语气。旧 `260215` 版本只应确认到视频画面理解，不能据此推断其也理解音轨。
- LAS 的“视频帧采样”是独立预处理算子，新版本范围已扩展到 **`0.1–10` FPS**；这不是火山方舟模型直接 `video_url` / `input_video` 的参数范围。[LAS 发布记录](https://www.volcengine.com/docs/6492/2165228?lang=zh)

因此，面向使用方最稳妥的说法是：**豆包 Seed 多模态模型可以解析视频；火山方舟直接视频输入默认 1 FPS、可调 0.2–5 FPS。若使用 LAS 独立抽帧算子，才是 0.1–10 FPS。**

## 四类模型的默认采样率对照

| 模型 / 接口 | 能否解析视频 | 默认视觉 FPS | 可配置范围 | 是否读视频音轨 |
|---|---:|---:|---:|---|
| Qwen3.5-Omni，百炼 HTTP | 是 | 2 | 0.1–10 | 是 |
| 支持视频的 Qwen3.8，百炼 HTTP | 是 | 2 | 0.1–10 | 否，仅官方声明视觉视频输入 |
| Gemini 普通视频输入 | 是 | 1 | `generateContent` 为 `(0, 24]`；Interactions 当前不可设 | 是 |
| 豆包 Seed，多模态方舟直接视频输入 | 是 | 1 | 0.2–5 | 仅已明确支持音频的版本可确认；如 Lite/Mini `260428` |

## LAS 视频帧采样独立在线算子：10 FPS 实际接入

### 结论与边界

LAS 的“视频帧采样”是托管的独立在线算子，算子 ID 为 `las_video_frame_extract`、版本为 `v1`。它只负责解码视频、按时间点抽取图片并写入 TOS，**不调用豆包模型，也不产生视频语义理解结果**。REST 接口是异步的 `POST /api/v1/submit` 和 `POST /api/v1/poll`，不是 Chat Completions 或 Responses 接口，也不需要自行部署 LAS“在线服务”。开通 LAS、创建 LAS API Key、准备同账号同地域的 TOS 后即可调用。[视频帧采样算子文档](https://www.volcengine.com/docs/6492/2165175?lang=zh) · [LAS 在线/离线算子说明](https://www.volcengine.com/docs/6492/1798368?lang=zh)

当前 REST 算子的 `fps` 范围是 **`0.1–10.0`**、默认 **`1.0`**。设置 `fps: 10.0` 后，算子从 `0` 秒开始，以 `0.1` 秒为间隔构造采样点，直到视频结束或达到 `max_frames`；这是抽帧频率，不是视频插帧，不会凭空生成新的运动信息。[算子详情](https://www.volcengine.com/docs/6492/2165175?lang=zh)与 [2026-06-02 发布记录](https://www.volcengine.com/docs/6492/2165228?lang=zh)均确认范围已由 `0.1–5.0` 扩展为 `0.1–10.0`。

需要特别注意：`max_frames` 超限后，REST 算子是**按时间顺序保留最前面的 N 帧并停止**，并不会在整段视频中重新均匀采样。因此，如果 10 FPS 和全片覆盖都重要，必须令 `max_frames >= ceil(视频时长秒数 × 10)`，或不传 `max_frames`；长视频更适合先切成较短片段再分别提交，避免单个 Poll 响应返回过大的 `frames` 数组。

这也与“视频内容理解（豆包系列）增强版”不同：后者算子 ID 是 `las_vlm_video`，输入视频和 Prompt，输出模型生成的文本；视频帧采样算子输出图片及其时间戳/TOS 地址。先用 `las_video_frame_extract` 抽到 10 FPS，**不代表**随后把原视频交给豆包模型时，模型也会看到这 10 FPS 的全部帧；若要利用这些帧，需要下游接口明确接收抽出的图片列表，并同时满足下游模型的图片数量和上下文限制。[视频内容理解（豆包系列）增强版](https://www.volcengine.com/docs/6492/2165094?lang=zh)

### 开通与准备

1. 在目标地域开通 LAS 并完成首次跨服务授权。只有主账号或有 `LASAIFullAccess` 的 IAM 子用户可以开通；个人实名认证账号默认不能完整使用算子服务，可能需要企业实名认证或提交工单。[LAS 准备工作](https://www.volcengine.com/docs/6492/1264537?lang=zh)
2. 在 LAS 控制台的“资源管理 > API Key 管理”创建 API Key，并放入 `LAS_API_KEY` 环境变量；一个主账号最多可创建 20 个 LAS API Key。[获取 API Key 并配置](https://www.volcengine.com/docs/6492/2191994?lang=zh)
3. 准备与 LAS **同主账号、同地域**且 LAS 可写的 TOS Bucket。输入 `video_url` 可以是公网可访问的 `http/https` URL，也可以是同账号同地域的 `tos://bucket/key`；输出则必须写入 TOS。
4. 选择地域 Base URL。视频帧采样支持北京、上海、广州；对应公网地址分别为 `https://operator.las.cn-beijing.volces.com`、`https://operator.las.cn-shanghai.volces.com`、`https://operator.las.cn-guangzhou.volces.com`。LAS 开发机可直接使用预置的 `$LAS_BASE_URL`。[获取 Base URL](https://www.volcengine.com/docs/6492/2191993?lang=zh)

### REST 请求参数

以下参数均来自[视频帧采样算子 v1 文档](https://www.volcengine.com/docs/6492/2165175?lang=zh)：

| 参数 | 必填 | 规则 |
|---|---:|---|
| `operator_id` | 是 | 固定为 `las_video_frame_extract`。 |
| `operator_version` | 是 | 固定为 `v1`。 |
| `data.video_url` | 是 | 公网 `http/https`，或同账号同地域的 `tos://bucket/key`。 |
| `data.output_path_template` | 是 | 必须指向具体 TOS 文件模板、必须包含 `{index}`；仅支持 `{index}` 与 `{autoext}`。例如 `tos://bucket/frames/frame_{index:06d}.{autoext}`。同名对象会被覆盖。 |
| `data.fps` | 否 | `[0.1, 10.0]`，默认 `1.0`；10 FPS 对应 `0.1` 秒一个采样点。 |
| `data.max_frames` | 否 | 必须大于 0；不传表示不限制。达到上限后只保留最前 N 帧，不做全片均匀重采样。官方没有公布除此之外的固定数值上限。 |
| `data.image_format` | 否 | `jpg` 或 `png`，默认 `jpg`。 |
| `data.resize_short_side` | 否 | 短边目标像素且保持宽高比；必须大于 0，实际短边上限 1080，输出宽高调整为偶数；与 `resize_hw` 互斥。 |
| `data.resize_hw` | 否 | `[width, height]`，元素为正整数或 `null`，至少一边非空；只给一边时等比缩放，两边都给时可能改变宽高比；与 `resize_short_side` 互斥。 |

### 可运行的 10 FPS REST 示例

下面的 `max_frames: 6000` 最多覆盖视频开头约 10 分钟；如果视频超过 10 分钟而全片 10 FPS 都重要，应增大/去掉该参数，或先切片后分别提交。

```bash
curl --location "https://operator.las.cn-beijing.volces.com/api/v1/submit" \
  --header "Content-Type: application/json" \
  --header "Authorization: Bearer $LAS_API_KEY" \
  --data '{
    "operator_id": "las_video_frame_extract",
    "operator_version": "v1",
    "data": {
      "video_url": "tos://my-bucket/videos/sample.mp4",
      "output_path_template": "tos://my-bucket/frames/sample/frame_{index:06d}.{autoext}",
      "fps": 10.0,
      "max_frames": 6000,
      "image_format": "jpg",
      "resize_short_side": 720
    }
  }'
```

Submit 成功会返回 `metadata.task_id`，初始状态通常是 `PENDING`。使用该 ID 调用 Poll：

```bash
curl --location "https://operator.las.cn-beijing.volces.com/api/v1/poll" \
  --header "Content-Type: application/json" \
  --header "Authorization: Bearer $LAS_API_KEY" \
  --data '{
    "operator_id": "las_video_frame_extract",
    "operator_version": "v1",
    "task_id": "task-20260420120000-abc123"
  }'
```

任务状态包括 `PENDING`、`RUNNING`、`COMPLETED`、`FAILED`、`TIMEOUT`；`task_id` 有效期为 3 天。完成且 `business_code` 为 `0` 时，Poll 返回：

- `video_duration`：原视频时长（秒）；
- `video_resolution`：原视频分辨率；
- `frame_count`：实际抽取帧数；
- `frames[]`：每帧的 `index`、`timestamp_seconds`、`width`、`height`、`tos_path`。`timestamp_seconds` 从 0 开始，并保留两位小数；10 FPS 时依次约为 `0.00`、`0.10`、`0.20`。

图片本体写入 `output_path_template` 指定的 TOS；Poll 返回的是这些对象的 `tos://` 路径，而不是把所有图片二进制嵌入响应。路径目标 Bucket 必须可写，且模板中的同名 TOS 对象会被覆盖。

### Daft 批处理方式

同一文档还提供 Daft 的 `VideoFrameSampler`。需要批量或分布式处理时，可使用 `sample_mode="by_fps"` 与 `target_fps=10.0`；Daft 路径与 REST 请求结构不同，输出可包含原始帧、base64、时间戳、解码帧索引和 TOS 路径。

```python
from daft import col
from daft.las.functions.udf import las_udf
from daft.las.functions.video.video_frame_sampler import VideoFrameSampler

sampler = las_udf(
    VideoFrameSampler,
    construct_args={
        "sample_mode": "by_fps",
        "target_fps": 10.0,
        "max_frames": 6000,
        "output_tos_dir": "tos://my-bucket/frames/sample",
        "img_type": ".jpg",
        "output_frames": False,
        "output_base64": False,
    },
)

result = dataset.with_column("sampled", sampler(col("video_path")))
```

Daft 还支持 `start_time_sec`、`end_time_sec`、`by_interval_time`、`by_interval_frames`、`by_timestamps` 等模式；REST v1 则只有从 0 秒开始的 FPS 抽取，没有起止时间参数。

### 10 FPS 的规模、成本与限制

- 算子按**实际抽取的图片张数**计费，单价为 **0.1 元/千张**。按 10 FPS 粗算：1 分钟约 600 张、0.06 元；10 分钟约 6000 张、0.6 元；1 小时约 36000 张、3.6 元。这里不含 TOS 存储、网络以及后续模型调用费用。[视频帧采样计费](https://www.volcengine.com/docs/6492/2165175?lang=zh)
- 官方性能上限为最大 600 RPM、最大并发 10；支持北京、上海、广州。
- REST 文档没有公布视频大小、视频时长或 `max_frames` 的固定数值上限；`max_frames` 不传即不限。但官方明确提醒，长视频可能产生大量图片、TOS 写入和很大的 Poll 响应。
- 10 FPS 只有在源视频本身有足够时间信息、目标动作确实发生在亚秒级时才会增加有效信息；它不能把低帧率源视频变成新的中间画面。
- 常见失败包括输入无法下载/解析、格式不支持、处理超时、抽帧失败及 TOS 无写入权限，对应 `Video.DownloadFailed`、`Video.Invalid`、`Video.FormatUnsupported`、`Video.Timeout`、`Video.FrameExtractionFailed` 和 `Tos.AccessFailed`。
