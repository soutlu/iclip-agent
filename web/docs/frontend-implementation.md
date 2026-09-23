# 前端实现规范

命令、职责边界和验证入口见 [AGENTS.md](../AGENTS.md)。全局视觉与交互规则见[设计系统](../../design-system.html)；组件 props、变体和尺寸以实现为准。

## 组件与状态

- 优先复用 `src/shared/ui/`。
- 组件 props 使用显式类型；类型靠近使用处，跨模块复用时再提取。通过判别字段或结构化校验收窄类型，先处理空值分支。
- 列表 key 使用稳定业务标识。className 组合使用 `cn()`；多变体样式用 `cva` 声明。
- 可取消的查询传递 `AbortSignal`。自定义 Hook 使用 `use*` 命名，返回值保持稳定结构。
- 主题由 `src/app/theme.ts` 统一作用于 `<html>` 的 `.dark`；组件使用主题 token，不各自维护主题状态。
- toast 使用 `@/shared/ui/toast`；进退场动画使用 `tw-animate-css` 的 `animate-in` / `animate-out`，时长与曲线取设计系统 token，不另写一套 toast 或进退场 keyframes。

## 内容与可访问性

- UI 文案使用中文，代码标识符使用英文。面向用户的界面不泄露 raw tool name、`member_id`、skill name、reference path 或原始 JSON 参数。
- 使用语义化元素。图片 alt 描述内容，装饰图片使用空 alt。
- 交互后的加载、错误、焦点与禁用状态遵守设计系统；组件的行为与可访问语义保持一致。

## 登录与守卫

- 未登录可进首页并看到应用壳；需要登录的动作经 `useLoginPrompt()` 请应用壳打开登录弹窗，账号密码登录成功后关闭弹窗、留在当前页。不设独立登录页，应用壳不统一拦截未登录用户。
- 整页需登录的路由用 `beforeLoad` + `ensureSessionUser()` 守卫，未登录回首页，不带 next、不自动弹窗。
- 登录弹窗只由应用壳持有，feature 不自行创建；登录通道只有飞书 SSO 与账号密码。
- SSO 整页跳转；回调失败回 `/?ssoError=<code>`，由应用壳展示错误，关弹窗时移除该参数。
- 普通接口的 401 / 403 只触发 `/users/me` 复核再重算路由，不据此认定已退出，也不自动弹窗；登录、登出、SSO 与会话探测中预期的 401 由认证流程自己处理。
- 登录状态变化后重算路由。退出登录停留当前页，由守卫决定是否回首页。

## 测试

每个行为选择最接近用户可观察边界的一层，不在多层重复相同断言。可观察边界包括界面、交互结果、HTTP 请求与响应、路由变化。

| 行为                                  | 测试层与入口                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 跨页面核心用户旅程                    | `e2e/` 中的 Playwright 用例，浏览器 MSW 提供后端响应                                                                       |
| feature 内组件、Hook 与 API 协作      | 组件测试，使用 `src/testing/render.tsx` 的 `renderWithProviders` 挂载真实子树；HTTP 通过 MSW，响应覆盖用 `server.use(...)` |
| 纯函数、投影、布局算法、解析器        | 纯输入输出单测，不 mock                                                                                                    |
| HTTP 路径、请求体、zod 边界与错误映射 | API 契约测试，断言请求形状或返回结果                                                                                       |

组件测试样例见 [login-form.test.tsx](../src/features/auth/components/login-form.test.tsx)。单测与被测源码同目录，使用 `*.test.ts[x]`；同一校验规则的多个分支用 `it.each` 表达。

- 按角色、可访问名或必要的 `data-testid` 定位，不依赖样式类；不把 className、style 或哈希类名作为行为断言。
- 不写读取 Provider / Hook 内部状态再投射成 DOM 的探针组件。测试所需浏览器边界使用现有测试适配器或 `vi.stubGlobal`。
- HTTP 使用 MSW，不手写 `fetch` stub。组件对外的回调 prop 可以用 `toHaveBeenCalledWith` / `toHaveBeenCalledTimes` 断言入参与次数；不对内部模块、Hook 或同仓函数做 spy；`toHaveBeenCalled*` 另用于剪贴板、`window.open` 等真实系统边界。
- 不快照 prompt 或自然语言措辞；通过可访问名定位控件与断言业务结果即可，文案本身是明确合同的情况除外。

同仓模块 mock 等语法限制由 [ESLint](../eslint.config.js) 检查。
