# 使用 Tiptap 官方扩展、JSON 草稿与共享引用协议

> **状态（2026-08-27）**：本决策描述的子系统已随前端重写整体删除，页面层重建时按本文重新落地或另开 ADR 取代。

日期：2026-07-20 ｜ 状态：已实施

## 决策

Producer 的 Home、Project Chat 和 Canvas Video 三个富文本输入入口统一使用 Media Composer 深模块；Storyboard 修改指令复用同一套 `shared/editor` 引用协议，只额外提供画面标注来源。编辑中的唯一文档格式是 Tiptap 原生 `JSONContent`：

```ts
type MediaComposerDocument = JSONContent
type StoryboardInstructionDocument = JSONContent
```

当前不在文档内添加 `{format, profile, schemaVersion, content}` 版本信封。持久化边界通过外层 storage 命名空间版本（例如 `producer.mediaComposer.pendingDraft.v1.*`）区分格式，并使用当前 Tiptap schema 严格解析裸 `JSONContent`；未知节点、属性或旧命名空间均不兼容。

JSON 是前端编辑草稿，不是 Storyboard 后端保存合同。提交 seam 只输出纯文本指令或 prompt 与业务附件；除已明确采用版本化 pending-draft storage 的 Media Composer 外，不因使用 Tiptap 就新增 JSON 持久化或后端字段。

依赖作为同一兼容簇精确锁定到 3.28.0：`@tiptap/core`、`@tiptap/pm`、`@tiptap/react`、`@tiptap/starter-kit`、`@tiptap/extension-placeholder`、`@tiptap/extension-mention`、`@tiptap/suggestion`、`@tiptap/extension-file-handler` 和 `@tiptap/extension-text-style`。升级这些包时必须整簇升级，并同时验证 schema、Suggestion 键盘交互、NodeView、FileHandler、类型检查和生产构建。

`@` 引用使用官方 Mention + Suggestion；展示使用 React NodeView；所有输入框共享稳定 ID、键盘交互、搜索、类型排序、失效处理、媒体图标、正文 chip 和候选菜单。媒体统一按图片、视频、音频排序，Storyboard 再追加标注、箭头、画笔、线框。弹层朝向和入口允许上传的附件类型可以根据页面能力配置，不属于引用业务规则；Storyboard 参考附件当前只允许图片。编辑器区域内的粘贴和拖放使用官方 FileHandler。文件格式校验、上传、数量限制、对象 URL 和附件排序仍是 Media Composer 业务层职责，不进入 Tiptap extension。

文档中的 `mediaReference` 节点只保存稳定 `id`。附件使用 `attachment:<attachmentId>`，项目媒体使用 `project:<assetId>`；节点不保存 URL、缩略图或会随排序变化的 canonical `label`。稳定 `id` 是编辑器和草稿内部的引用身份；当前 `label` 由 reference catalog 在读取时解析，并同时用于编辑器 UI、搜索、剪贴板序列化和最终 prompt。Media Composer 的 `label` 直接对应其领域 `promptKey`，例如 `image_1`、`video_1` 或 `audio_1`。`MediaComposerSubmission` 只包含附件和纯文本 prompt，引用在 prompt 中投影为 `@label`；AG-UI 请求最终发送文本与媒体 file parts，不另行发送引用 ID，也不把 Tiptap JSON、HTML 或 Editor 实例泄漏给 runtime。

Storyboard 的 `storyboardInstructionReference` 同样只保存稳定 `id`；当前图片入口和画面标注从 catalog 派生唯一 canonical `label`，例如 `image_1` 或 `M01`。chip、候选菜单、搜索和提交文本使用同一 `label`，引用类型只由统一 SVG 表达。用户在当前编辑器中主动删除附件或标注时，同步移除指向该来源的 Mention；如果来源是被外部 catalog 变化移除，则保留节点、显示“引用已失效”并在提交边界拒绝，避免静默丢失草稿内容。

## 为什么

- 旧实现同时维护 Tiptap HTML、纯文本 token、手写 mention 状态和 React 附件状态，存在多套事实源；删除或排序附件需要同步改写字符串协议。
- 官方 Mention、Suggestion、React NodeView 和 FileHandler 已覆盖编辑器协议层能力，自研 document 监听、Editor ref 桥接和 media-chip Node 没有继续存在的必要。
- 稳定引用 ID 把“资源身份”与“当前 canonical label”分开。附件排序可以改变 `image_1` 等 label，而无需重写文档节点；UI 和提交边界在读取时使用同一个最新 label。
- Tiptap 原生 JSON 避免了只为编辑器内部状态增加一层自定义协议；持久化的外层命名空间版本与 schema 严格校验仍会明确拒绝未知格式，不把错误 JSON 静默解释成空文本或旧格式。

## 硬约束（违反即回归）

- 不读取、不迁移、不生成 `[[media-chip:...]]`，也不恢复旧 HTML/plain-text adapter。
- 不暴露 Tiptap `Editor`、ProseMirror transaction、Suggestion 开关或弹层坐标给 Home、Project 或 Canvas feature。
- `mediaReference.attrs.id` 必须稳定；本地附件上传为远端附件时保留原 `id`、`kind`、`name` 和顺序。
- `storyboardInstructionReference.attrs.id` 同样必须稳定；附件或标注的 canonical label 变化不得改写节点身份。
- reference ID 与 canonical `label` 都必须唯一；Media Composer 的 `label` 对应其领域 `promptKey`。编辑器 UI、搜索、剪贴板序列化和提交投影必须直接使用同一 `label`，不得建立第二 label 或搜索别名。提交边界对无法解析的引用、重复 label、mention-only 草稿和非法 schema 直接报错。编辑器展示与剪贴板序列化对悬空引用显示 `【引用已失效】`，但不将其伪装成可用 label。
- Project pending draft 只使用 `producer.mediaComposer.pendingDraft.v1.*`，内容必须是远端附件加当前 Tiptap JSON 文档；旧 `producer.project.pendingDraft.*` 和 `{files,text}` 不兼容、不读取。
- Project 提交时冻结结构化草稿并立即清空输入区；运行期间禁用编辑。成功后只释放提交快照的对象 URL，失败后恢复同一结构化快照，避免长 run 结束时误清新草稿。
- `shared/editor` 是输入框引用协议和视觉的唯一实现；feature 不得再复制 Suggestion 生命周期、媒体类型排序、引用 SVG、NodeView DOM 或 chip / 候选 CSS。已发送消息中的媒体引用同样复用共享 chip，避免提交前后切换视觉。附件 tray / stack 仍属于页面布局，不纳入统一。

## 后果

- `MediaComposerEditor` 成为编辑器边界；页面只交换 `MediaComposerDocument`、reference catalog 和提交 intent。
- `StoryboardInstructionEditor` 只增加 Storyboard catalog adapter 与布局配置，不再拥有第二套媒体引用 UI。
- `MediaComposerDraft` 是草稿状态合同，`MediaComposerSubmission` 是发送给运行时前的业务投影合同。
- Project store、Home 跨页 pending draft 和 Canvas 本地状态使用同一套文档/附件转换函数。
- 删除旧 `MediaChipExtension`、`ComposerEditor`、`useRichTextEditor`、手写 mention/popup、token parser 及其兼容测试；通用文件接入、附件栈、媒体预览和只读消息渲染继续复用。
