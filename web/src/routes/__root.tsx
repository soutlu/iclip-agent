import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootLayout,
})

/**
 * 渲染应用根布局（全局样式在 main.tsx 引入）。
 *
 * @returns 根路由出口。
 */
function RootLayout() {
  return <Outlet />
}
