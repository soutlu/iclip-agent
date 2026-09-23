import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { addMockConversation, addMockTask, loginAs, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { FakeSocket } from '@/testing/ws'

/** 标题由路由层按行取，要用真实路由树挂整页；侧栏顶层要订全局帧，连接用假 socket。 */
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
}

afterEach(() => {
  queryClient.clear()
})

describe('审计页的需求单标题', () => {
  it.each([
    ['conversations', '对话明细'],
    ['anomalies', '异常列表'],
  ])('%s 标签里，挂在选择器候选之外的需求单显示真实标题', async (tab, region) => {
    loginAs(mockGovernor)
    const task = addMockTask('去年冬季羊毛系列')
    addMockConversation('羊毛外套尝试').taskId = task.id
    // 选择器候选只取最近一页，这张更早的需求单不在里面；只有按 id 批量读才读得到。
    server.use(
      http.get('*/api/tasks', ({ request }) => {
        const ids = new URL(request.url).searchParams.getAll('ids')
        const items = ids.includes(task.id) ? [task] : []
        return HttpResponse.json({ items, nextCursor: null, total: items.length })
      }),
    )

    await renderAt(`/audit?tab=${tab}`)

    const list = await screen.findByRole('region', { name: region })
    expect(await within(list).findByText(task.title)).toBeVisible()
    expect(within(list).queryByText('需求单')).not.toBeInTheDocument()
  })
})
