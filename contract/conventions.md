# 跨端合同约定

> server 与 web 之间 wire 契约的总约定。golden fixtures v2（M1 起）与本文件同为合同事实源：**改合同的一侧负责同步两端，任何一端门禁红即合同漂移**。

## 1. 部署与路径

- 前端浏览器只调同源 `/api/*`；dev 由 vite proxy、prod 由反代把 `^/api` rewrite 掉直达后端根路径（`/api/users/me` → 后端 `/users/me`）。无 BFF。
- 反代与 vite proxy 必须放行 WebSocket upgrade（`ws: true` / 透传 `Upgrade` 头）。

## 2. 双主体认证

- **浏览器用户**：HttpOnly cookie `iclip_session`（JWT）。后端种、浏览器自动携带；前端 JavaScript 不持有、不存储、不转发任何 token。登录 `POST /auth/login`（form-urlencoded）成功返回 204 + Set-Cookie，响应体不含 token。
- **机器调用方**：`Authorization: Bearer iclip_sk_...`。key 权限 ⊆ 属主当下权限；创建响应仅一次返回明文。
- 两类主体命中同一套端点与权限词汇表；服务端把任何客户端提交的身份字段视为不可信。
- WebSocket 握手：浏览器走 cookie + Origin 校验（非法 Origin 拒绝 close 1008）；机器走握手头 Bearer。

## 3. Payload 风格

- HTTP API 一律 **camelCase**（含查询参数与响应字段）。
- 登录态唯一事实源：`GET /users/me` → `{ "user": { ...camelCase, role, permissions, city, jobTitle, departments[] } }`；401 表示未登录。
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

## 5. golden fixtures v2（M1 起）

- fixtures = **JSON 事件序列数组**（传输中立）；SSE 帧格式、WS 信封各自只有独立的小编码测试。合同锁事件序列，不锁传输帧。
- 每条事件流必须独立通过 run 序列校验（RUN_STARTED 起、有且仅有一个终止事件、text/tool 配对闭合）。
- 套件随里程碑分批启用：M1 = new/replay/snapshot/cancel 子集；HITL fixture 形状先从旧系统捕获锁定、M4 实现时启用。
- **严禁从新后端输出重新生成 fixtures**——迁移期 fixtures 是冻结验收标准。

## 6. 传输规划

命令面（run 发起 / resume / cancel / restore）**永久 HTTP**；事件投递 M1 为 SSE（`Accept: text/event-stream` 内联流），web 重构期切换统一 WS 网关（信封 `{channel, seq, payload}`，run 频道载荷为标准 AG-UI 事件原文），SSE 随后退役。同一 run 端点按 `Accept` 协商两种投递。
