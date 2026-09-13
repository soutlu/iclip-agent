import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { addMockConversation, addMockUser, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { FakeSocket } from '@/testing/ws'

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

/** 使用应用路由树与 queryClient 单例，确保 beforeLoad 和 ensureSessionUser 共用身份缓存；侧栏顶层要订全局帧，连接用假 socket。 */
const renderAt = async (initialPath: string) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree,
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider createSocket={() => new FakeSocket() as unknown as WebSocket}>
        <RouterProvider router={router} />
      </TranscriptProvider>
    </QueryClientProvider>,
  )

  return router
}

const loginAs = (permissions: readonly string[]) =>
  server.use(
    http.get('*/api/users/me', () => HttpResponse.json({ user: { ...mockAuthUser, permissions } })),
  )

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

  it('全部对话页只放治理者进：没登录或没有 users:manage 都回首页', async () => {
    const anonymous = await renderAt('/audit')
    expect(anonymous.state.location.pathname).toBe('/')

    queryClient.clear()
    loginAs(mockAuthUser.permissions)
    const plain = await renderAt('/audit')
    expect(plain.state.location.pathname).toBe('/')
  })

  it('治理者进全部对话页，看到别人的对话与属主名', async () => {
    loginAs([...mockAuthUser.permissions, 'users:manage'])
    const other = addMockUser('小王')
    addMockConversation('小王的秋季片').ownerUserId = other.id

    const router = await renderAt('/audit')

    expect(router.state.location.pathname).toBe('/audit')
    expect(await screen.findByRole('heading', { name: '全部对话' })).toBeVisible()
    expect(await screen.findByRole('link', { name: /小王的秋季片/ })).toBeVisible()
    expect(screen.getByText('小王')).toBeVisible()
  })
})
