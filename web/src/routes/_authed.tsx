import { createFileRoute, Outlet } from '@tanstack/react-router'
import { requireSession } from '@/shared/auth'

// 登录守卫：/_authed 前缀下的所有路由都要求已登录（会话以 GET /users/me 为事实源）。
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ location }) => {
    await requireSession(location.href)
  },
  component: AuthedLayout,
})

/**
 * 渲染鉴权布局（Producer 页面自带整页外壳，这里只透传出口）。
 *
 * @returns 鉴权路由出口。
 */
function AuthedLayout() {
  return <Outlet />
}
