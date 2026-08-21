# 跨端合同约定

> 对外 wire 契约的总约定，**由后端定义**：本文件是合同事实源，前端按本文对接。

## 1. 部署与路径

- 前端浏览器只调同源 `/api/*`；dev 由 vite proxy、prod 由反代把 `^/api` rewrite 掉直达后端根路径（`/api/users/me` → 后端 `/users/me`）。无 BFF。
- 反代与 vite proxy 必须放行 WebSocket upgrade（`ws: true` / 透传 `Upgrade` 头）。

## 2. 双主体认证

- **浏览器用户**：HttpOnly cookie `iclip_session`（JWT）。后端种、浏览器自动携带；前端 JavaScript 不持有、不存储、不转发任何 token。登录 `POST /auth/login`（form-urlencoded）成功返回 204 + Set-Cookie，响应体不含 token。
- **机器调用方**：`Authorization: Bearer iclip_sk_...`。key 有效权限即签发时的显式授权集（不随属主角色变化；签发需 `api_keys:issue`，授予集 ⊆ 签发者当下权限，见 [ADR-0002](../docs/adr/0002-unified-permission-model.md)）；创建响应仅一次返回明文。
- 两类主体命中同一套端点与权限词汇表；服务端把任何客户端提交的身份字段视为不可信。
- WebSocket 握手：浏览器走 cookie + Origin 校验（非法 Origin 拒绝 close 1008）；机器走握手头 Bearer。

## 3. Payload 风格

- HTTP API 一律 **camelCase**（含查询参数与响应字段）。
- 登录态唯一事实源：`GET /users/me` → `{ "user": { ...camelCase, roles[], directPermissions[], permissions[], city, jobTitle, departments[] } }`；401 表示未登录（[ADR-0002](../docs/adr/0002-unified-permission-model.md)）。
- 时间戳 ISO 8601 UTC；id 为服务端生成的不可猜测字符串。

## 4. 错误信封

错误响应为 JSON `{ "detail": "<人类可读消息>" }`；领域错误到状态码的映射固定：

| 领域错误 | HTTP |
|---|---|
| AuthenticationFailed（未认证 / 凭证无效 / key 吊销过期） | 401 |
| PermissionDenied（可见但无权） | 403 |
| NotFound（不存在**或不可见**——不泄露存在性） | 404 |
| Conflict（乐观并发 / 状态机冲突） | 409 |
| ValidationFailed（请求语义非法） | 422 |

不做部分成功、不做静默降级：结构非法即整体失败。
