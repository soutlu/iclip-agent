import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { addMockConversation, addMockUser, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { FakeSocket } from '@/testing/ws'
import { conversationsReturnSearch } from './-conversations-return'

/** 筛选存在地址栏，要用真实路由树连着历史记录一起看；侧栏顶层要订全局帧，连接用假 socket。 */
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

const signedInAsGovernor = () =>
  server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockGovernor })))

afterEach(() => {
  queryClient.clear()
  window.sessionStorage.clear()
})

describe('全部对话的筛选条件', () => {
  it('地址栏带着属主就只列他的对话，退回来还是这一屏', async () => {
    signedInAsGovernor()
    const other = addMockUser('小王')
    const theirs = addMockConversation('小王的秋季片', '2026-09-02T00:00:00Z', other.id)
    addMockConversation('自己的冬季片', '2026-09-03T00:00:00Z')
    const user = userEvent.setup()

    const router = await renderAt(`/conversations?ownerUserId=${other.id}`)

    const row = await screen.findByRole('link', { name: /小王的秋季片/ })
    expect(screen.queryByRole('link', { name: /自己的冬季片/ })).toBeNull()

    await user.click(row)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${theirs.id}`))

    router.history.back()

    await waitFor(() => expect(router.state.location.pathname).toBe('/conversations'))
    expect(router.state.location.search).toEqual({ ownerUserId: other.id })
    expect(await screen.findByRole('link', { name: /小王的秋季片/ })).toBeVisible()
    expect(screen.queryByRole('link', { name: /自己的冬季片/ })).toBeNull()
  })

  it('改筛选换地址不堆历史记录，并留给对话页的返回按钮', async () => {
    signedInAsGovernor()
    addMockConversation('自己的冬季片', '2026-09-03T00:00:00Z')
    const user = userEvent.setup()

    const router = await renderAt('/conversations')
    await screen.findByRole('link', { name: /自己的冬季片/ })

    await user.click(screen.getByRole('radio', { name: '进行中' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ state: 'running' }))
    await waitFor(() => expect(conversationsReturnSearch()).toEqual({ state: 'running' }))
    expect(router.history.length).toBe(1)
  })
})
