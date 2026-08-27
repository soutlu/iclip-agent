# Producer 领域锚点

本文是 Producer 前端的领域锚点：上下文（前端的背景事实）、术语、不变量（每条代码路径都必须成立的规则）、禁止逻辑（被刻意设计掉的推理模式）。页面层已整体删除，这里只剩仍然成立的部分；新页面落地时把它的术语与不变量补回来。

命令、边界与门禁见 [AGENTS.md](AGENTS.md)；接口形状见 [../contract/openapi.json](../contract/openapi.json)，合同表达不了的约定见 [../contract/conventions.md](../contract/conventions.md)。

## 上下文

- **定位**：Producer 是 Productor 视频创作产品的前端 SPA，放在 iclip-agent monorepo 的 `web/`；浏览器只经同源 `/api` 访问后端，登录态为 HttpOnly cookie。
- **界面主体**：登录页（飞书 SSO 为主通道、账号密码为辅）、鉴权外壳（页头 + 用户菜单）、空首页。

## 术语

**当前用户（`/users/me`）**：
登录态与权限的唯一事实源。`permissions` 是后端权限字符串数组（如 `analytics:read`），前端所有权限门控只判它。
_不是_：前端缓存的用户名、角色名推断、任何 token 解码结果。

## 不变量

1. **登录态只存在于后端种的 HttpOnly `iclip_session` cookie**；`GET /api/users/me` 是登录态唯一事实源（经 react-query-auth 进 TanStack Query 缓存）。前端 JavaScript 不持有、不存储、不转发任何 token（[ADR-0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)）。
2. **浏览器只调用同源 `/api/*`**；vite proxy / 生产反代负责 `^/api` rewrite，cookie 自动携带，前端不注入 `Authorization` 头。host-only cookie 不跨 `localhost` / `127.0.0.1` 共享，同一登录会话必须固定 Host。`FRONTEND_PUBLIC_ORIGIN` 只定义 SSO 回跳的前端公开 origin。
3. **任意接口 401 / 403 都先强刷 `/users/me` 再重算路由守卫**；跳登录与保留 `redirect` 由 `_authed` 守卫负责，接口自身的错误文案由调用方就地展示。
4. **权限门控只判 `user.permissions` 后端权限字符串**。
5. **边界过 zod、非法即失败**：环境变量经 `env.ts` schema，REST 响应经 `apiFetch(path, schema)`，schema 来自生成契约。
6. **不伪造数据**：后端缺的字段保留 `null` / `undefined`，不在前端补默认值冒充事实。

## 禁止逻辑

- **认证转换层思维**：BFF、cookie 换发、`producer_access_token`、localStorage 会话、前端注入 `Authorization`。同源部署下这层转换没有存在价值（ADR-0001）。
- **身份白名单**：用前端用户名列表做权限门控。
- **组件里的主题分支**：`data-theme`、主题 Provider、组件自己判断明暗。浅深两套 token 同名换档，主题只由 `<html>` 上的 `.dark` 决定（`src/app/theme.ts` 是唯一开关），组件照常引用 token 即可。
