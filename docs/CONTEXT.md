# iclip-agent 领域锚点

iclip-agent 是 Productor 视频创作产品的重写主体。本文命名产品赖以工作的持久事实与瞬态信号（术语）、每条代码路径都必须成立的规则（不变量）、以及被刻意设计掉的推理模式（禁止逻辑）。

领域真理不随实现里程碑出现而诞生——本文自 M0 起完整登记；尚未有对应代码的条目以 **（M1）（M2）（M3）** 标注生效里程碑，实现落地时不得偏离本文再「重新设计」。命令与门禁见 [../AGENTS.md](../AGENTS.md)；机制见 [architecture.md](architecture.md)。

## 术语

### M0 已生效

**主体（Principal）**：
一次请求的唯一可信身份：`kind ∈ {user, api_key}`、`user_id`（key 也归属用户）、`api_key_id?`、生效权限集。由宿主的 PrincipalResolver 每 hop 解析一次，下游一切只消费它。
_不是_：客户端提交的任何身份字段、可在下游二次解码的 token、两套并行的用户/机器身份模型。

**API Key**：
`iclip_sk_` 前缀的长期凭证，归属某个用户；服务端只存 SHA-256 哈希与展示前缀，明文仅创建响应出现一次。key 的权限是**显式授予集**，永远 ⊆ 属主当下权限。
_不是_：角色的镜像、独立账号体系、可查回明文的凭证。

**双主体（Dual Principal）**：
同一套产品能力对两类调用方开放：浏览器用户（HttpOnly cookie `iclip_session`）与机器调用方（`Authorization: Bearer iclip_sk_...`）。两者解析为同一 Principal 类型，权限词汇表相同。
_不是_：两套 API、两套权限系统、为机器单开的旁路。

### 随里程碑生效的领域术语

**运行目标（Run Target）**（M1）：
承载一个对话运行的顶层 Agent。它是**对话**的属性而非项目的属性：建对话时选定、之后不可改；换运行目标即开新对话。
_不是_：模型配置、项目级绑定、可中途切换的选择。

**Run 事件日志（EventJournal）**（M1）：
append-only 的运行事件事实（run_id + seq，AG-UI 投影事件）。一切投递面（SSE / WS / restore / replay）都是它的消费者。
_不是_：worker 内存缓冲、传输帧格式、可被投影层改写的数据。

**Run 流恢复（Run Stream Recovery）**（M1）：
前端断线后重发一次普通 startRun；「新 run 还是重连」由服务端归因（比对入站用户消息 id 与已受理集合）。前端不持有 backend run id、event cursor，也不做任何重连路由决策。
_不是_：前端事件拼接、自定义 pending 运行时、轮询模式。

**生成事实（Generation Fact）**（M2）：
一条媒体生成生命周期的持久记录，含当前状态与关联的媒体、用量记录。产品通过读取生成事实恢复当前状态。
_不是_：事件流、通知日志、队列项。

**生成通知 / 唤醒信号**（M2）：
「某条生成事实可能变了」的瞬态提示。消费方只能把它当作「去读最新事实」的信号；它可能迟到或丢失，正确性来自数据库对账。
_不是_：事实源、exactly-once 事件、投递保证。

**终态可见性屏障（Terminal Visibility Barrier）**（M2）：
生成终态对产品可见的时间点。跨过屏障之前，必需的终态事实（产出媒体、用量记录）必须已经持久化。
_不是_：终态通知、副作用触发器、provider 终态响应。

**生成认领 / 同步窗口**（M2）：
认领 = 一个 worker 对「同步某条生成事实与 provider」的短时独占权（只协调分工，不是产品状态）；同步窗口 = 距下次复查的间隔期。认领决定「谁来查」，窗口决定「该不该再查」。生成同步失败 ≠ 生成失败。
_不是_：任务所有权、生成状态、退款触发器。

**素材（Asset）**（M2）：
媒体在**共享素材库**中的不可变身份行：同 `(url, assetType)` 全库一个身份（get-or-create，最早行胜出）；`user_id`/`project_id`/`session_id` 只是登记信息、不构成可见性。
_不是_：project/session/用户归属物、可改写的行。

**session 账本（session_assets）**（M2）：
「什么素材进入过这个 session」的正向成员登记，是 agent 工具使用资格的唯一事实源。账本约束的是 agent，从不约束用户。工具面以素材 URL 查账本；AssetId 只是服务端内部主键。
_不是_：素材身份、可见性作用域、对用户可发送内容的限制。

**创作分级（Creative Hierarchy）**（M2）：
自上而下五级——视频 > 镜头组 > 结构层级 > 镜头 > 帧。镜头组是交付视频生成的单元，总时长 4–30 秒，切点只落在结构层级边界。
_不是_：兼指结构层级时长与镜头的「时间段」。

**视频创作任务（Video Task）**（M3）：
一次被发布的结构化视频创作要求；创建时唯一必需输入是 `styleNo`，后端把品牌、品类和产品首图冻结为独立 `style` 产品快照，原子插入完整 draft。发布生命周期 `draft → published → confirmed → withdrawn`（published 与 confirmed 均可撤回）；过期是派生状态。
_不是_：创作模板、执行工作单、交付容器、可在发布后覆盖的表单草稿。

**VideoTaskSession**（M3）：
Video Task 与 Session 的显式关系（`session_id` 唯一标识关系）。一个 Task 可对应多个 Session，一个 Session 最多对应一个 Task。
_不是_：按 target、顺序或时间推断出的关系。

**项目画布布局（Project Canvas Layout）**（M3）：
项目节点位置的完整持久快照，由稳定 `nodeId`、有限数坐标和 `layoutMode` 组成；`revision`/`expectedRevision` 是替换快照的乐观并发契约。
_不是_：React Flow 瞬态、viewport、单节点事件日志。

## 不变量

每条代码路径都必须成立；能机械守卫的由门禁强制（AGENTS.md §7）。破坏任何一条是设计变更，不是重构。未生效条目按标注里程碑落地，落地即入门禁。

1. **Postgres 是唯一持久化事实源。**（M0 起）业务事实、会话/消息/run 事实（M1）、workspace 文件（M1）都落 Postgres；worker 进程内存只承载当前连接、当前 run 或性能缓存，绝不承载跨 worker 正确性。
2. **可信身份只来自宿主建立的唯一 `Principal`。**（M0）PrincipalResolver 每 hop 只解析一次（cookie 验签一次 / key 哈希查表一次 + 活跃属主加载一次），写入 `request.state.principal`；下游不得再解码 token、查询用户或消费客户端身份字段。Principal 解析与传输无关：HTTP 中间件、WS 握手（cookie + Origin 校验）与 Bearer 头共用同一解析器。
3. **API key 权限 ⊆ 属主当下权限。**（M0）创建时校验授予集 ⊆ 属主权限；解析时取 key 授予集与属主当下权限的交集，属主停用/降权即时生效；过期或吊销的 key 一律 401。
4. **key 行为可审计。**（M0 起，随事实表扩展）所有事实行记录 `user_id + api_key_id?`——谁的 key 干的，永远可追。
5. **密钥只存在于环境变量。**（M0）配置 YAML 只存 `*_env` 变量名；运行必需的 env 在 bootstrap 阶段快速失败；API key 只存哈希。
6. **跨 worker 互斥与幂等来自数据库**（原则 M0 起，落地 M2）：行锁、`FOR UPDATE SKIP LOCKED` 认领租约、唯一索引。
7. **run 生命周期由 RunLedger + EventJournal 持有。**（M1）没有自定义 pending 运行时、没有本地 run 队列；事件先落库再下发；归因与幂等只依据 RunLedger。
8. **AG-UI 面遵循官方协议语义。**（M1）标准 `state/tools/context`、快照、增量与 restore；合同锁 JSON 事件序列，不锁传输帧。
9. **唤醒信号可能迟到或丢失，正确性永远来自对账。**（M2）消费方从数据库重读事实。
10. **终态可见性屏障约束终态写入顺序。**（M2）必需的终态事实先持久化，再翻状态，最后发唤醒信号；终态转换只允许来自非终态，崩溃后重放屏障安全。
11. **用户提交的生成行一旦存在即产品可见**（M2）——哪怕 provider task id 还没有、哪怕提交链路随后失败（该行变成 failed 生成，而不是被隐藏的请求失败）。
12. **工具媒体输入的资格由 session 账本裁决。**（M2）媒体工具只接受本 session 账本内的素材 URL；校验发生在任何模型调用之前；失败不留半写文件。执法在 harness 装配层统一实施，不依赖能力包自觉。
13. **workspace 路径永远解析到会话根之下**（M1）：tenant / 哈希用户 / 会话段校验，拒绝绝对路径、`..`、symlink 逃逸；原始用户 id 永不落盘。
14. **运行目标只有一个声明事实源。**（M1）YAML 声明 → 装配期冻结；路由、白名单、能力挂载都从它派生，不得各自重建平行映射。
15. **Asset 是不可变账本行。**（M2）登记后不得替换内容或改写 URL，不得物理删除；归档只令其退出新选择范围。
16. **Style 快照从创建起冻结；正式 Task 只开放确认补充。**（M3）published/confirmed 仅允许策划师调整 `requirementDescription`、`durationSeconds`、`ratio`、`referenceImages`、`referenceVideos` 与管理信息；其余创作输入冻结。
17. **Video Task 与 Session 只通过 `video_task_sessions` 显式关联。**（M3）不得按 target、数组顺序或时间推断关系。
18. **Task 的创作媒体只保存纯 Asset id。**（M3）参考视频写入前必须在服务端转为 H.264 MP4 派生 Asset，失败不写 Task；Agent 不参与转码。
19. **一个 Video Task 只对应一个 Style 号；正式 Task 永久保留；Task 不按用户隔离**（M3）：创建用户只用于审计；引用数只按 published/confirmed/withdrawn 去重聚合。
20. **创建 Video Task 是一次原子写入。**（M3）不得先创建半成品 draft 再二次补写。
21. **项目画布布局只按完整快照保存。**（M3）`expectedRevision` 不匹配明确 409，不做 last-write-wins；布局更新不触碰项目元数据更新时间。
22. **行级归属语义**（M0 起）：不可见资源返回 `NotFound`（不泄露存在性），可见但禁止才是 `PermissionDenied`；manager 视角不加 owner 过滤。

## 禁止逻辑

被刻意设计掉的推理模式，不得以「临时方案」名义重新引入：

- **信任客户端身份。**（M0）任何来自 body / query / header（除凭证本身）/ `forwardedProps` 的 userId、tenantId、role 都不得进入可信路径；暂停的 run 按 session 定位而不是按客户端 run id（M1）。
- **把 key 当角色用。**（M0）不得给 key 授予「随属主角色自动膨胀」的权限；扩权只能重新显式授予。
- **把通知当事实。**（M2）唤醒信号的 payload 不得当状态用。
- **伪造可恢复流或终态。**（M1）事件日志不完整时只允许：在途且宽限内显式可重试错误，或以 DB 已落库事实合成降级快照收尾；绝不用残缺数据伪造实时 delta，也不为无终止事件的 run 合成成功终态。
- **把同步失败混同为生成失败；把认领混同为产品状态。**（M2）
- **推断 VideoTaskSession。**（M3）关系只能读取关系表。
- **盲写或隐式合并画布布局。**（M3）
- **静默兜底。**（M0）配置 env 缺失、持久化状态形状非法、协议边界损坏——都在最早的边界大声失败，而不是降级运行。
- **让能力包自带执法。**（M2）账本资格 / 授权 / 审计只在 harness 装配层实施一次。
