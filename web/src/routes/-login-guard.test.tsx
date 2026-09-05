import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'

// jsdom 缺少 Lottie 的 canvas 支持；替换装饰动画，保留真实路由守卫。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

/** 使用应用路由树与 queryClient 单例，确保 beforeLoad 和 ensureSessionUser 共用身份缓存。 */
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

// 每例清理单例 queryClient，避免登录缓存污染后续测试。
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

  it('未登录直接访问会话页时挡回首页', async () => {
    const router = await renderAt('/c/11111111-1111-4111-8111-111111111111')

    expect(router.state.location.pathname).toBe('/')
    expect(await screen.findByLabelText('输入消息')).toBeVisible()
  })
})
