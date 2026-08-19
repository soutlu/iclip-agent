# 前端实现规范

> 覆盖目录边界、组件、Hook、TypeScript、质量和测试。视觉规则见 [设计系统](./design-system.html)，跨层状态见 [状态与跨层契约](./state-management.md)。
> 其中可机械化的规则（分层依赖、TS 严格性、部分代码风格）已由 ESLint flat config（boundaries 架构守卫）+ tsc strict 强制，以 `eslint.config.js` / `tsconfig.app.json` 为准；本文记录门禁之外仍需人判断的约定。

## 目录边界

分层与依赖方向由 ESLint boundaries 硬约束（违反即报错，测试文件豁免）：

- `src/main.tsx → src/app/**`：应用壳（providers、router 装配、`globals.css`）。
- `src/routes/**`：TanStack Router 文件式路由 = 薄胶水层，只做守卫（`beforeLoad`）+ search params + 组装 feature 页面；路由树自动生成到 `src/routeTree.gen.ts`（不手改、lint/format 排除）。
- `src/features/<domain>/**`：业务竖切，互相隔离；对外能力只经各自 `index.ts` 显式导出，跨 feature 复用下沉 `shared/` 或在 routes/app 层组装。
- `src/shared/**`：领域无关的横切能力（ui、api client、auth、markdown、config、lib）。
- `src/testing/**`：开发原型与测试基建（当前为 MSW mocks 与 dev:mock 启动入口），只被测试与开发启动入口引用，业务代码不得引用。
- 只被单一路由使用的组件先留在该 feature 内；被第二处真实复用时再下沉。
- 新增文件前先 `rg` 查同类命名和现有 helper，避免新建平行实现；文件名 kebab-case。

## 组件与 JSX

- React 组件内部不要定义另一个 React 组件。
- 组件 props 必须有显式类型；共享 props 类型遵守本文件的类型规则。
- 列表 key 使用稳定业务标识，不使用数组 index。
- 不把 `children` 当普通 props 传递；不同时使用 `children` 和 `dangerouslySetInnerHTML`。
- 不使用危险 JSX props，不重复写同一个 JSX 属性。
- 无 children 的组件不要写额外闭合标签；使用 `<>...</>`，不写 `<Fragment>...</Fragment>`。
- 使用 `target="_blank"` 时必须同时设置 `rel="noopener"`。
- UI 颜色、字体、层级、间距、交互状态、圆角和阴影以 [设计系统](./design-system.html) 为准。
- className 拼接统一走 `cn()`（clsx + tailwind-merge），不手写模板拼接。
- 新组件的多变体样式（`variant`/`size` 等档位 props）用 `cva`（class-variance-authority）声明；存量的零散条件类不做批量迁移。

```tsx
type ProjectCardProps = {
  projectId: string;
  title: string;
};

/**
 * 展示项目入口卡片。
 *
 * @param props - 项目卡片属性。
 * @returns 项目卡片元素。
 */
export const ProjectCard = (props: ProjectCardProps) => {
  return <article>{props.title}</article>;
};
```

## 可访问性

- `<button>` 必须包含 `type`。
- SVG 必须包含 `title`。
- `<html>` 必须包含 `lang`。
- `<iframe>` 必须包含 `title`。
- 需要 alt 的元素必须提供有意义文案，且不要包含 “image”、“picture” 或 “photo”。
- 锚点必须有屏幕阅读器可访问内容。
- `label` 必须有文本内容并关联对应 input。
- `onClick` 必须配套键盘事件；`onMouseOver` / `onMouseOut` 必须配套 `onFocus` / `onBlur`。
- 优先使用语义化元素，不用 role 伪装语义。
- 不使用 `accessKey`、正整数 `tabIndex`、可聚焦元素上的 `aria-hidden="true"`。
- 不给非交互元素分配交互 ARIA role，也不给交互元素分配非交互 ARIA role。

## Hooks

- React Hooks 只能在组件函数或自定义 Hook 顶层调用。
- Hook 依赖数组必须完整、正确；不要靠禁用 lint 保持旧闭包。
- 自定义 Hook 使用 `use*` 命名，返回值保持稳定结构。
- feature 私有 Hook 放在该 feature 内；跨 feature 复用后再下沉 `shared/`。
- 数据获取优先走现有 api helper（`src/shared/api/` 与各 feature 的 `api/`），并传递 `AbortSignal` 处理卸载、项目切换和新 run 中止。

## Rich Markdown 渲染器

- 画布 Markdown artifact 必须通过 `src/shared/markdown/RichMarkdownRenderer` 渲染，不在 artifact 卡片内重组 `react-markdown` 插件。
- `RichMarkdownRendererProps` 固定为 `markdown: string`、`identity: string`、`className?: string`、`variant?: "canvas-preview" | "expanded-preview"`。
- 调用方必须传稳定 `identity`，用于标题 id、测试定位和嵌套工具 key。
- 插件链路固定包含 GFM、GitHub Alert、CJK 友好强调、数学公式、raw HTML、KaTeX、标题 id 和 SVG 自适应。
- 模型 HTML 视为可信内容，不添加 sanitize、DOMPurify、allowlist 或兜底分支。
- `<style>` 内容必须随整棵 Markdown 进入同一个 Shadow DOM，避免污染全局样式。
- 代码块和表格工具只提供展示与复制；编辑、HTML live preview、Excel 导出不进入基础 renderer。
- 画布节点需要大尺寸阅读时，用独立 dialog 展开预览，不直接拉高 canvas node。
- 表格第一列常用于字段名或标签，保持紧凑且不拆中文字符换行（`white-space: nowrap`、`word-break: keep-all` 保护 CJK 标签宽度）；正文列可换行承接长文本，但不得因第一列被压成单字多行而撑高整行。
- 修改 `.rich-markdown-body table` / `th` / `td` 或画布缩放相关样式时，必须用「短中文标签 + 长中文正文」两列表格在画布节点里验收首行高度。

## 编辑器引用

首页、项目聊天、Canvas 和 Storyboard 的正文 `@` 引用共用 `src/shared/editor` 一套实现：

- **身份与 label**：Tiptap JSON 只保存稳定 `id`；reference catalog 为每个引用派生唯一 canonical `label`（`image_n` / `video_n` / `audio_n` / `Mxx`），chip、候选、搜索、剪贴板序列化和提交边界都用同一 label，不建立第二 label 或搜索别名；label 变化或附件重排不改写节点身份。
- **排序与目录**：候选统一按 `image → video → audio → note → arrow → brush → frame` 排序，只展示当前输入框目录中实际存在的类型。Storyboard 可额外提供画面标注，但不得改变搜索、键盘、chip、图标、候选或提交规则。
- **视觉规格**：正文 chip 固定高 20px，来源缩略图 16×16px，类型底座 12×12px，内部 SVG 7×7px，圆角 `--radius-sm`；候选菜单复用同一来源、图标与标签结构。类型图标统一用 `editor-reference-icons.svg` 的 `reference-*` symbol，颜色来自成对的 `--color-reference-*` 与 `--color-on-reference`（边框身份色 35%、背景 9%、图标底实色）。这些颜色只表达引用身份，不替代状态语义，也不跟随标注笔触色；组件不得重写色值或建第二套类型色。
- **删除与失效**：用户在当前页面主动删除附件或标注时同步删除指向该来源的 Mention；撤销恢复来源不自动复活已删 Mention。外部 catalog 丢失来源时保留原 JSON 节点、显示「引用已失效」，由提交边界拒绝。
- **入口能力**：可上传附件类型属于入口能力，不属于 Mention 规则——通用 Media Composer 允许图片/视频/音频；Storyboard 参考附件入口仅图片（`allowedKinds` 表达），不得在引用 adapter 内虚构入口无法创建的媒体类型。
- **布局边界**：候选弹层可按容器空间上/下方展开，不改变排序与键盘规则；附件托盘属页面布局（Storyboard 托盘图片 28×28px），不纳入正文引用组件，也不能用于推导 chip 尺寸。

## TypeScript

- 类型定义靠近使用处；跨模块复用时再提升到共享类型文件。
- 类型导入使用 `import type`，类型导出使用 `export type`。
- 初始化为字面量表达式的变量不要额外添加类型注解。
- 默认数组类型写 `T[]`，同一模块内保持一致。
- 不使用 `any`、TypeScript enum、namespace、非空断言后缀 `!`。
- enum 需求使用 `as const` 对象和索引访问类型表达。
- 通过判别字段、类型谓词或结构化校验完成类型收窄；先处理 `null` / `undefined` 分支。
- 接口边界过 zod：环境变量只从 `src/shared/config/env.ts` 读取，新变量先在 schema 声明。

## 质量规则

- 每个函数和类必须添加 Google 风格中文 docstring/JSDoc，说明职责、参数、返回值、错误或副作用。
- UI 文案中文；代码标识符英文。
- 不使用 `var`、全局 `eval()`、`@ts-ignore`、硬编码密钥、未使用变量/导入/私有成员。
- 不写不必要的 fragment、catch、constructor、label、常量条件、嵌套三元、参数重赋值、变量遮蔽、import cycle、循环内 `await`。
- 只赋值一次的变量使用 `const`；使用箭头函数，不使用 function expression。
- 使用 `for...of`，不使用 `Array.forEach`；使用 `.flatMap()`，不使用 `.map().flat()`。
- 使用 optional chaining、模板字符串、`===` / `!==`；`Date.now()` 获取 Unix Epoch 毫秒。
- Promise-like 语句必须 `await`、`return` 或显式捕获错误。
- `switch` 必须穷尽处理并包含 `default`。

## 测试要求

> 前端当前无自动化测试（见 [AGENTS.md](../AGENTS.md) §1），本节是测试重写时的编写规范；重写落地前，这些规则没有机械强制。

### 行为归层：每个行为只在一个层测，选最接近用户可观察边界的层

前端的"用户可观察边界"= 渲染出的界面（角色 / 可访问名 / 文本）、交互后的界面变化、发出的 HTTP 请求形状、路由变化。写任何新测试前按顺序判定：

1. **跨页面的核心用户旅程**（登录 → 项目 → 聊天 → 生成）→ e2e（`e2e/`，Playwright）。
2. **单个 feature 的行为**（含组件 + hook + store + api 协作）→ 组件测试：渲染**真实子树**，用统一的 `renderWithProviders` 测试工具（随测试重写在 `src/testing` 重建），网络经 MSW（`src/testing/mocks`），断言用户可见结果与发出的请求形状。
3. **纯函数**（事件投影、布局算法、解析器）→ 纯数据进出的单测，零 mock。
4. **HTTP api 层**（端点 URL、请求体、zod 边界、错误映射）→ api 契约测试。

同一行为禁止在多层重复覆盖：util 层测过的算法不在 store 层复测坐标，api 层测过的请求形状不在组件层再断一遍 fetch mock。

### 禁止事项（随测试重写由 test-guard 恢复机械强制）

- **禁止 `vi.mock` 同仓模块**（`@/…` 与相对路径）。把协作方 mock 掉后断言"假组件收到的 props"对回归零防护、对重构全阻力。第三方不可 jsdom 运行的库（如 `@xyflow/react`）与浏览器 API 用 `vi.stubGlobal` / MSW，不 mock 同仓代码。api 层与纯函数测试天然零 mock。
- **禁止断言 className / style / 哈希类名选择器**（`.foo-caj6Zi`、`h-[75px]` 等）。视觉正确性由 design-guard 棘轮 + AGENTS.md §6 人类视觉验收负责，不属于单测。测试定位元素用角色、可访问名或 `data-testid`，不用样式类。
- **禁止手搓 `fetch` stub + `toHaveBeenCalled` 断请求**。网络一律 MSW handlers，断言"发出了什么请求 / 界面因响应变成什么样"。`toHaveBeenCalled*` 只用于真正的系统边界（`window.open`、剪贴板等）。
- **禁止内部状态探针**：不写读取 Provider context / hook 内部状态再摊平成 DOM data-* 的探针组件；断言用户可见结果。
- **禁止把提示词与文案文本当契约断言**：不快照 prompt / 界面文案措辞，文本微调不是行为回归；断行为与结构，不断措辞。

### 存量与基建

- 变更共享逻辑、跨层契约、运行时适配器或用户可见行为时，必须补充或更新对应层的测试；错误分支、空数据、并发/时序风险按**风险优先级**取舍断言——只覆盖守护真实风险的边界，不为覆盖率穷举输入空间堆用例。
- 单测与被测文件同目录（`*.test.ts[x]`）；同一校验规则的多个拒绝分支用 `it.each` 规则表，不逐分支复制 arrange。
- **分层执行节奏**：开发内环只跑被改 surface 的定向测试，不反复跑全量；提交前 `pnpm ci:check`；合入 / 发布前 `pnpm verify`。视觉验收按 [AGENTS.md](../AGENTS.md) §6 人类门禁执行。
