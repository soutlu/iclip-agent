import { createRouter } from '@tanstack/react-router'
import type { ComponentType } from 'react'
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

// 401 后强刷 /users/me 并重算路由；/users/me 自身不触发全局处理，避免递归。
setOnUnauthorized(refreshSessionThenInvalidateRoutes)

// 403 可能表示权限已变更，强刷 /users/me 后重算路由；原请求错误仍由调用方展示。
setOnForbidden(refreshSessionThenInvalidateRoutes)

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }

  // 右面板由当前匹配路由的 staticData 声明，壳负责渲染。
  interface StaticDataRouteOption {
    rightPanel?: ComponentType
  }
}
