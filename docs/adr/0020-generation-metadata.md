# ADR-0020：生成任务的坐标由调用方以 `metadata` 自带，生成域不认识分镜

- 状态：已接受（2026-09-12）
- 关联：[ADR-0009](0009-storyboard-workbench.md)（决策里 `generation_jobs` 加 `shot_index` 列的部分由本文修订）、[ADR-0018](0018-video-generation-mirrors-upstream.md)（`task_id` 落列不变）、[ADR-0004](0004-generation-queue-in-postgres.md)（排队与状态机不变）

## 背景

分镜页要把一次生成对回「哪个镜头组、哪一帧」。此前这两项分居两处：`shot_index` 是 `generation_jobs` 上的一列，`frameNumber` 藏在图片请求的 `request` JSON 里，列表接口再用 `request->>'frameNumber'` 去筛。结果是生成域的表与请求模型都认识「镜头组」「帧」这两个分镜词，`request` 也不再是发给 provider 的输入：`frameNumber` 谁都不读，只为筛选而存。前端拿到的形状还不对称，`shotIndex` 在记录顶层，`frameNumber` 要去 `request` 里翻。

坐标必须落在服务端：刷新、换设备后按格查记录、在帧上挂状态都要靠它。要解决的是它落在哪、由谁解释。

## 决策

### 1. 一列不透明的 `metadata`

`generation_jobs` 加 JSONB 可空列 `metadata`，删 `shot_index`。它与 `task_id` 同类，是归属标签：调用方原样写入，服务端原样存、原样回读、不读里面的键、不校验含义。两种生成的请求体都收 `metadata`，`GenerationOut` 顶层回读，`event.generation.changed` 帧的 payload 原样带出。

### 2. `request` 只存 provider 输入

`metadata` 进 `ORIGIN_FIELDS`，与 `conversation_id`、`task_id` 一样写库时从 `request` 里剔掉，也不转发上游。`frameNumber` 从图片请求模型删除。留在 `request` 里的 `shot` 不算例外：服务端要从它拼正文，它是输入的前身。

### 3. 筛选是 JSONB 包含匹配

`GET /generations?metadata=<JSON 对象>` 按 `@>` 筛，与 `kind`、`conversationId`、`taskId` 一样在分页截断前生效。不建索引：按坐标筛永远发生在按对话缩小之后，量小。查询串里不是 JSON 对象返回 `422`。

### 4. 大小有上限

序列化后不超过 2000 字符（`MAX_METADATA_CHARS`），请求体与查询串同一条线。它是标签不是仓库；本仓所有自由输入都有上限，这一项不例外。

### 5. 分镜页的形状归前端

分镜页写 `{"path": <分镜文件路径>, "shot": <镜头组>, "frame": <第几帧>}`，视频出片不带 `frame`。形状在 `web/src/features/storyboard/generation-metadata.ts` 一处定义并校验，生成记录抽屉、帧角标、编辑器按格查询都从这里读。换一个调用方（API key、别的页面）可以写自己的形状，生成域不需要知道。

## 取舍

- **接受**：`metadata` 没有类型，服务端拦不住写错键的调用方。分镜页在前端 zod 校验，读不出坐标的记录就当没有坐标。
- **接受**：存量回填假设所有旧记录都来自 `video_shot.json`。这是仓库里唯一的分镜文件路径（web 的 `SHOTS_PATH`），迁移 `0002_generation_metadata` 按它写 `path`。
- **接受**：内存替身的包含匹配只做顶层键相等；Postgres 的 `@>` 对嵌套对象是递归包含。分镜页的坐标是平的，替身不模拟嵌套。
- **不做**：把 `conversation_id`、`task_id` 也并进 `metadata`。它们有索引、有跨域查询语义，是真正的归属；坐标只是调用方的备注。
