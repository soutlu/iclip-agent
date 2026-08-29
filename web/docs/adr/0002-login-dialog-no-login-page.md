# 登录改成首页弹窗，去掉登录页与路由守卫

未登录可以进首页，看到完整外壳（侧栏、输入卡）与占位内容；点需要登录的动作时弹出登录弹窗，
登录成功就地关闭，不离开当前页面。`/login` 路由与 `_authed` 守卫删除。

## 硬约束（违反即回归）

- 不重建登录页路由，也不重建「未登录 → redirect 到某个页面」的路由守卫。
- 需要登录的动作调 `useLoginPrompt()`（`src/routes/-login-prompt.tsx`）请求登录；弹窗状态只归应用壳
  `src/routes/_shell.tsx` 持有，feature 不自己开登录弹窗，也不互相认领。
- 登录通道仍只有飞书 SSO 与账号密码两条，不加手机号验证码、不加协议勾选。
- SSO 是整页跳转：`/auth/sso/landing` 换会话失败时回 `/?ssoError=<code>`，应用壳据此打开弹窗并把错误码
  从地址里清掉（留着会导致每次刷新重新弹窗）。
- 接口 401 / 403 只强刷 `/users/me` 并重算路由，不自动弹窗——页面就地退回未登录形态，用户下次动手时才弹。

## 后果

- 首页从 `/_authed/` 移到 `/_shell/`，`_shell` 不做登录判断。
- `LoginForm` 不再自己跳转，登录成功走 `onSuccess`；`shared/auth` 的 `requireSession`、`ensureSessionUser` 随之删除。
- 退出登录不跳转，当前页就地退回游客态。
- 取代 [ADR-0001](0001-vite-spa-same-origin-no-bff.md)「后果」里关于路由守卫跳转的两条。
