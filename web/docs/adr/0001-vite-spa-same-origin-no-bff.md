# Vite SPA 与同源后端，无 BFF

## 决策

前端使用 Vite SPA、TanStack Router 与 TanStack Query。浏览器经同源代理访问后端，开发与生产使用相同的路径 rewrite；认证和代理细节见[跨端合同](../../../contract/conventions.md)。

- 不建立 BFF，不换发前端自己的会话 cookie，不恢复 `producer_access_token`。
- 用户登录状态由后端建立，前端通过 `/users/me` 查询；不在 JavaScript 中保存会话凭证或为后续 API 注入 Bearer Token。SSO 回调页面只将临时票据交给后端完成登录。
- 真实后端开发不注册浏览器 MSW；mock 仅在显式 `mock` mode 启用，不混用真实认证与局部 mock。
- 登录交互、会话复核与路由守卫遵守 [ADR-0002](0002-login-dialog-no-login-page.md)。

## 取舍

本项目不需要 SSR。旧 BFF 只在后端会话 cookie 与前端 cookie 之间转换；同源部署可以直接使用后端 HttpOnly 会话。移除这层后，生产反向代理承担路径转发与 WebSocket 支持。
