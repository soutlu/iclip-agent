# 前端实现规范

> 覆盖组件、Hook、TypeScript、质量和测试。视觉规则见 [设计系统](../../design-system.html)。

## 新增一个契约组件

先确认 `design-system.html` §组件契约 那张表里有它，实现照表走，尺寸、状态、圆角、层级都不自己发挥。表里没有的先改表再写代码。

## 组件与 JSX

- 组件 props 必须有显式类型；共享 props 类型遵守本文件的类型规则。
- 列表 key 用稳定业务标识。
- UI 颜色、字体、层级、间距、交互状态、圆角和阴影以 [设计系统](../../design-system.html) 为准。
- className 拼接统一走 `cn()`（clsx + tailwind-merge），不手写模板拼接。
- 新组件的多变体样式（`variant`/`size` 等档位 props）用 `cva`（class-variance-authority）声明。

```tsx
type ProjectCardProps = {
  projectId: string
  title: string
}

export const ProjectCard = ({ title }: ProjectCardProps) => <article>{title}</article>
```

## 可访问性

- 图标一律经 `@/shared/icons` 的 `Icon`：有含义的传 `label`，纯装饰的传 `decorative`，不手写 `<svg>`。
- 优先使用语义化元素，不用 role 伪装语义。
- alt 文案写内容本身，不写「图片」「照片」这类词。

## Hooks

- React Hooks 只能在组件函数或自定义 Hook 顶层调用。
- Hook 依赖数组必须完整、正确；不要靠禁用 lint 保持旧闭包。
- 自定义 Hook 使用 `use*` 命名，返回值保持稳定结构。
- feature 私有 Hook 放在该 feature 内；跨 feature 复用后再下沉 `shared/`。
- 数据获取优先走现有 api helper（`src/shared/api/` 与各 feature 的 `api/`），并传递 `AbortSignal` 处理卸载与切页。

## TypeScript

- 类型定义靠近使用处；跨模块复用时再提升到共享类型文件。
- 初始化为字面量表达式的变量不要额外添加类型注解。
- 默认数组类型写 `T[]`，同一模块内保持一致。
- 枚举语义用 `as const` 对象加索引访问类型表达。
- 通过判别字段、类型谓词或结构化校验完成类型收窄；先处理 `null` / `undefined` 分支。

## 质量规则

- UI 文案中文；代码标识符英文。
- 不写不必要的 fragment、catch、嵌套三元、参数重赋值、变量遮蔽、循环内 `await`。
- 箭头函数、`for...of`、`.flatMap()`、optional chaining、模板字符串；不用 function expression、`forEach`、`.map().flat()`。

## 测试要求

### 行为归层

每个行为只在一个层测，选最接近用户可观察边界的层。前端的"用户可观察边界"= 渲染出的界面（角色 / 可访问名 / 文本）、交互后的界面变化、发出的 HTTP 请求形状、路由变化。写任何新测试前按顺序判定：

1. **跨页面的核心用户旅程**（登录 → 进入业务页 → 完成一次提交）→ e2e（`e2e/`，Playwright）。
2. **单个 feature 的行为**（含组件 + hook + api 协作）→ 组件测试：渲染**真实子树**，用 `renderWithProviders`（`src/testing/render.tsx`：新 QueryClient + 内存路由）挂载，网络经 MSW（`src/testing/mocks`，需要改响应时 `server.use(...)` 覆盖单个端点），断言用户可见结果与发出的请求形状。`login-form.test.tsx` 是这一层的样板。
3. **纯函数**（事件投影、布局算法、解析器）→ 纯数据进出的单测，零 mock。
4. **HTTP api 层**（端点 URL、请求体、zod 边界、错误映射）→ api 契约测试。

同一行为禁止在多层重复覆盖。

### 禁止事项

- **禁止 `vi.mock` 同仓模块**（`@/…` 与相对路径）。第三方不可 jsdom 运行的库与浏览器 API 用 `vi.stubGlobal` / MSW，不 mock 同仓代码。
- **禁止断言 className / style / 哈希类名选择器**（`.foo-caj6Zi`、`h-[75px]` 等）。测试定位元素用角色、可访问名或 `data-testid`，不用样式类。
- **禁止手搓 `fetch` stub + `toHaveBeenCalled` 断请求**。网络一律 MSW handlers，断言"发出了什么请求 / 界面因响应变成什么样"。`toHaveBeenCalled*` 只用于真正的系统边界（`window.open`、剪贴板等）。
- **禁止内部状态探针**：不写读取 Provider context / hook 内部状态再摊平成 DOM data-\* 的探针组件；断言用户可见结果。
- **禁止把提示词与文案文本当契约断言**：不快照 prompt / 界面文案措辞；断行为与结构，不断措辞。

### 存量与基建

- 变更共享逻辑、跨层契约、运行时适配器或用户可见行为时，必须补充或更新对应层的测试。
- 单测与被测文件同目录（`*.test.ts[x]`）；同一校验规则的多个拒绝分支用 `it.each` 规则表，不逐分支复制 arrange。
