import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { addMockConversation, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { FakeSocket } from '@/testing/ws'

/** 重定向发生在会话页的 beforeLoad，要用应用真实路由树才看得到；侧栏顶层要订全局帧，连接用假 socket。 */
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

const signedIn = () =>
  server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))

// 每例清理单例 queryClient，避免登录缓存污染后续测试。
afterEach(() => {
  queryClient.clear()
})

describe('会话页地址里的对话 id', () => {
  it('无横线写法换成规范写法，查询参数带过去', async () => {
    signedIn()
    const conversation = addMockConversation('秋季片')

    const router = await renderAt(`/c/${conversation.id.replaceAll('-', '')}?sheet=prompt`)

    expect(router.state.location.pathname).toBe(`/c/${conversation.id}`)
    expect(router.state.location.search).toEqual({ sheet: 'prompt' })
  })

  it('规范写法原地不动', async () => {
    signedIn()
    const conversation = addMockConversation('冬季片')

    const router = await renderAt(`/c/${conversation.id}`)

    expect(router.state.location.pathname).toBe(`/c/${conversation.id}`)
  })

  it('不是 UUID 的写法不跳转，交给页面自己的找不到', async () => {
    signedIn()

    const router = await renderAt('/c/not-a-uuid')

    expect(router.state.location.pathname).toBe('/c/not-a-uuid')
  })
})
