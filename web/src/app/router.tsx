import { createRouter } from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { setOnForbidden, setOnUnauthorized } from '@/shared/api/client'
import { refreshSessionUser } from '@/shared/auth'

export const router = createRouter({
  defaultPreload: 'intent',
  routeTree,
  scrollRestoration: true,
})

let sessionRecoveryPromise: null | Promise<void> = null

/**
 * 合并并发的 401/403 会话复核，避免同一批失败重复请求身份事实源或重算路由。
 */
const refreshSessionThenInvalidateRoutes = () => {
  if (sessionRecoveryPromise) {
    return
  }

  sessionRecoveryPromise = refreshSessionUser()
    .then(() => router.invalidate())
    .catch((error: unknown) => {
      console.error('重新确认登录态失败', error)
    })
    .finally(() => {
      sessionRecoveryPromise = null
    })
}

// 任意普通接口 401 都先强刷唯一事实源 /users/me；确认结果为 null 后，重新执行的
// _authed 守卫才负责跳登录并保留 redirect。/users/me 自身已豁免全局处理，不会递归。
setOnUnauthorized(refreshSessionThenInvalidateRoutes)

// 权限不足：任意接口 403 → 本地权限可能已过期（如角色被调整），强刷 /users/me 后重算
// 路由守卫；失去当前页面权限的用户由守卫送回首页，接口错误文案仍由调用方就地展示。
setOnForbidden(refreshSessionThenInvalidateRoutes)

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
