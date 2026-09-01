import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'

// lottie-web 在模块加载时就探测 canvas 2d context，jsdom 里拿不到会直接抛。
// 被挡回首页时会渲染到 hero 动画，这里只关心落在哪个路由。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

/**
 * 用真实路由树在指定地址起一个内存路由——守卫写在路由上，只有整棵树跑起来才测得到。
 * 用的是应用同一个 queryClient 单例，因为 ensureSessionUser 读的就是它。
 *
 * @param initialPath - 起始地址。
 * @returns 加载并挂载完的 router。
 */
const renderAt = async (initialPath: string) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree,
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  return router
}

// 登录态缓存在单例 queryClient 里，staleTime 30s，不清会串到下一个用例
afterEach(() => {
  queryClient.clear()
})

describe('整页要登录的那几页', () => {
  it('未登录直接访问 /tasks 时挡回首页', async () => {
    const router = await renderAt('/tasks')

    expect(router.state.location.pathname).toBe('/')
    expect(await screen.findByLabelText('输入消息')).toBeVisible()
  })

  it('已登录时正常进入需求单页', async () => {
    server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))

    const router = await renderAt('/tasks')

    expect(router.state.location.pathname).toBe('/tasks')
    expect(await screen.findByRole('heading', { name: '需求单' })).toBeVisible()
  })

  // 对话是私有的：拿到别人的链接也不该看见内容，更不该让页面自己去打一发注定 401 的请求。
  it('未登录直接访问会话页时挡回首页', async () => {
    const router = await renderAt('/c/11111111-1111-4111-8111-111111111111')

    expect(router.state.location.pathname).toBe('/')
    expect(await screen.findByLabelText('输入消息')).toBeVisible()
  })
})
