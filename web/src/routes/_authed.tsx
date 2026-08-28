import { createFileRoute, Outlet } from '@tanstack/react-router'
import { requireSession } from '@/shared/auth'
import { AppSidebar } from './-app-sidebar'

// 登录守卫：/_authed 前缀下的所有路由都要求已登录（会话以 GET /users/me 为事实源）。
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ location }) => {
    await requireSession(location.href)
  },
  component: AuthedLayout,
})

/**
 * 渲染鉴权布局：侧栏是应用级外壳，页面只负责内容。
 *
 * 侧栏放这里而不是放进某个 feature——它每个登录页都要有，塞进 feature 就会逼出
 * 跨 feature 依赖，而跨 feature 是禁止的。
 *
 * @returns 带侧栏的鉴权路由出口。
 */
function AuthedLayout() {
  return (
    <div className="flex min-h-dvh">
      <AppSidebar />
      <Outlet />
    </div>
  )
}
