# ADR-0020：生成任务的坐标由调用方以 `metadata` 自带，生成域不认识分镜

- 状态：已接受（2026-09-12）
- 修订（2026-09-15）：视频请求增加 `shot_index`，是 `metadata.shot` 的别名，受理时折进 `metadata`；服务端仍不读 `metadata` 里的键，只是替不写坐标的调用方写这一个。
- 修订（2026-09-20）：分镜页的坐标去掉 `path`，只剩 `{"shot"}` / `{"shot", "frame"}`。它是一行常量（仓库里只有一份 `video_shot.json`），却被前端当成必填，于是只发 `shot_index` 的调用方出的片在分镜页一条都显示不出来。存量由迁移 `0012_generation_metadata_drop_path` 清掉，不留读侧兼容。
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

分镜页写 `{"shot": <镜头组>, "frame": <第几帧>}`，视频出片不带 `frame`；图片编辑另带 `sourceUrl`，记这次改的是哪张图——底图未必还在分镜里，这一帧出现过的图要靠它从任务列表重新拼出来。按坐标筛选时不带 `sourceUrl`。形状在 `web/src/features/storyboard/generation-metadata.ts` 一处定义并校验，生成记录抽屉、帧角标、编辑器按格查询都从这里读。换一个调用方（API key、别的页面）可以写自己的形状，生成域不需要知道。

视频编辑（ADR-0028）的三条记录——参考片段、编辑结果、成片——写另一组平键 `{"rootJob", "baseJob", "editId", "editStart", "editEnd"}`：`rootJob` 是链的根（最初那条出片），链查询按它筛；`baseJob` 是这次基于的完整视频；`editId` 由前端铸，把三条串成一次编辑；`editStart` / `editEnd` 是相对基底的区间，在编辑结果与成片上记的是按参考片段实际时长反算出来的关键帧起点，不是用户选的那个数。**不带 `shot`**：编辑结果不是这一镜的出片，抽屉与审计都不该把它算进去；抽屉只在原片那张卡上数一下被编辑过几次。同一份文件里定义与校验。

## 取舍

- **接受**：`metadata` 没有类型，服务端拦不住写错键的调用方。分镜页在前端 zod 校验，读不出坐标的记录就当没有坐标。
- **接受**：`sourceUrl` 是 2026-09-13 加的，此前的图片编辑记录没有这一项，翻不出它们的底图。不回填：底图当时是哪张，事后推不出来。
- **接受**：`path` 从写入、读取与存量数据里一并去掉，不留读侧兼容分支。代价是一个对话将来要放两份分镜文件时得把它加回来；今天产物注册表按 `SHOTS_PATH` 精确匹配，一个对话只认一份，这个字段区分不了任何东西。历史：迁移 `0002_generation_metadata` 按唯一的 `video_shot.json` 回填过 `path`，`0005_generation_metadata_cleanup` 清掉了只剩 `path` 的坐标，`0012_generation_metadata_drop_path` 把这一行从所有坐标里删掉。
- **接受**：内存替身的包含匹配只做顶层键相等；Postgres 的 `@>` 对嵌套对象是递归包含。分镜页的坐标是平的，替身不模拟嵌套。
- **不做**：把 `conversation_id`、`task_id` 也并进 `metadata`。它们有索引、有跨域查询语义，是真正的归属；坐标只是调用方的备注。
