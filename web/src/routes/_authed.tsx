import { createFileRoute, Outlet } from '@tanstack/react-router'
import { ProducerUserMenu } from '@/features/auth'
import { requireSession } from '@/shared/auth'

// 登录守卫：/_authed 前缀下的所有路由都要求已登录（会话以 GET /users/me 为事实源）。
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ location }) => {
    await requireSession(location.href)
  },
  component: AuthedLayout,
})

/**
 * 渲染鉴权布局：页头是应用级外壳，页面只负责内容。
 *
 * 页头放这里而不是放进某个 feature——它每个登录页都要有，塞进 feature 就会逼出
 * 跨 feature 依赖，而跨 feature 是禁止的。
 *
 * @returns 带页头的鉴权路由出口。
 */
function AuthedLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-(--layout-project-header-height) shrink-0 items-center justify-between px-6">
        <span className="text-title-lg font-semibold tracking-tight text-on-surface">Producer</span>
        <ProducerUserMenu />
      </header>
      <Outlet />
    </div>
  )
}
