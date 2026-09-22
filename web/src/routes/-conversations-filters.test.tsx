import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import {
  addMockConversation,
  addMockTask,
  addMockUser,
  mockGovernor,
} from '@/testing/mocks/handlers'
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

describe('全部对话的需求单预览', () => {
  it('列表中的需求单直接展示创作要求与商品图，只有参考图的没有缩略图，历史需求单只补取一次', async () => {
    signedInAsGovernor()
    const recent = addMockTask('夏季上新')
    recent.inputs.creative_requirement = '用自然光展示亚麻衬衫的质感'
    recent.inputs.products = recent.inputs.products.map((product) => ({
      ...product,
      image_oss_urls: ['https://example.com/shirt.jpg'],
    }))
    const historical = addMockTask('冬季上新')
    historical.inputs.creative_requirement = '呈现羊毛外套的通勤搭配'
    historical.inputs.reference_image_oss_urls.outfit = ['https://example.com/outfit.jpg']
    addMockConversation('衬衫尝试').taskId = recent.id
    addMockConversation('外套尝试一').taskId = historical.id
    addMockConversation('外套尝试二').taskId = historical.id
    const detailRequests: string[] = []
    server.use(
      http.get('*/api/tasks', () => HttpResponse.json({ items: [recent] })),
      http.get('*/api/tasks/:taskId', ({ params }) => {
        detailRequests.push(String(params['taskId']))
        return HttpResponse.json({ task: historical })
      }),
    )

    await renderAt('/conversations')

    const recentRow = await screen.findByRole('link', { name: /衬衫尝试/ })
    expect(await within(recentRow).findByText(recent.inputs.creative_requirement)).toBeVisible()
    expect(within(recentRow).getByRole('img')).toHaveAttribute(
      'src',
      'https://example.com/shirt.jpg',
    )
    // 缩略图只认商品图：这张需求单只有参考图，列表行就不放图。
    for (const title of ['外套尝试一', '外套尝试二']) {
      const row = await screen.findByRole('link', { name: new RegExp(title) })
      expect(await within(row).findByText(historical.inputs.creative_requirement)).toBeVisible()
      expect(within(row).queryByRole('img')).toBeNull()
      expect(within(row).getByText('暂无图片')).toBeVisible()
    }
    expect(detailRequests).toEqual([historical.id])
  })

  it('历史需求单读取失败仍保留成功预览，并将失败与未关联区分', async () => {
    signedInAsGovernor()
    const recent = addMockTask('可读取的需求')
    recent.inputs.creative_requirement = '拍摄背包容量与收纳分区'
    const historical = addMockTask('历史需求')
    historical.inputs.creative_requirement = '用街拍风格表现皮鞋的日常穿搭'
    addMockConversation('背包演示').taskId = recent.id
    addMockConversation('历史尝试').taskId = historical.id
    addMockConversation('自由创作')
    server.use(
      http.get('*/api/tasks', () => HttpResponse.json({ items: [recent] })),
      http.get('*/api/tasks/:taskId', () =>
        HttpResponse.json({ message: '读取失败' }, { status: 500 }),
      ),
    )

    await renderAt('/conversations')

    const recentRow = await screen.findByRole('link', { name: /背包演示/ })
    expect(await within(recentRow).findByText(recent.inputs.creative_requirement)).toBeVisible()
    const failedRow = await screen.findByRole('link', { name: /历史尝试/ })
    expect((await within(failedRow).findAllByText('需求单信息暂不可用')).length).toBeGreaterThan(0)
    const unlinkedRow = await screen.findByRole('link', { name: /自由创作/ })
    expect(within(unlinkedRow).getByText('未关联需求单')).toBeVisible()

    server.use(http.get('*/api/tasks/:taskId', () => HttpResponse.json({ task: historical })))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '重新读取需求单' }))

    expect(await within(failedRow).findByText(historical.inputs.creative_requirement)).toBeVisible()
    expect(screen.queryByRole('button', { name: '重新读取需求单' })).toBeNull()
  })

  it('没有需求单读取权限时不请求素材并保留对话审计', async () => {
    server.use(
      http.get('*/api/users/me', () =>
        HttpResponse.json({
          user: {
            ...mockGovernor,
            permissions: mockGovernor.permissions.filter(
              (permission) => permission !== 'tasks:read',
            ),
          },
        }),
      ),
    )
    const requests: string[] = []
    server.use(
      http.get('*/api/tasks', ({ request }) => {
        requests.push(request.url)
        return HttpResponse.json({ items: [] })
      }),
      http.get('*/api/tasks/:taskId', ({ request }) => {
        requests.push(request.url)
        return new HttpResponse(null, { status: 403 })
      }),
    )
    addMockConversation('关联需求的对话').taskId = crypto.randomUUID()

    await renderAt('/conversations')

    const row = await screen.findByRole('link', { name: /关联需求的对话/ })
    expect((await within(row).findAllByText('无需求单查看权限')).length).toBeGreaterThan(0)
    expect(requests).toEqual([])
  })
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
    // 返回按钮认这段对话是从这一屏点进去的；换一段就没这条记录。
    expect(conversationsReturnSearch(theirs.id)).toEqual({ ownerUserId: other.id })
    expect(conversationsReturnSearch('别的对话')).toEqual({})

    router.history.back()

    await waitFor(() => expect(router.state.location.pathname).toBe('/conversations'))
    expect(router.state.location.search).toEqual({ ownerUserId: other.id })
    expect(await screen.findByRole('link', { name: /小王的秋季片/ })).toBeVisible()
    expect(screen.queryByRole('link', { name: /自己的冬季片/ })).toBeNull()
  })

  it('改筛选只换地址不堆历史记录', async () => {
    signedInAsGovernor()
    addMockConversation('自己的冬季片', '2026-09-03T00:00:00Z')
    const user = userEvent.setup()

    const router = await renderAt('/conversations')
    await screen.findByRole('link', { name: /自己的冬季片/ })

    await user.click(screen.getByRole('radio', { name: '进行中' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ state: 'running' }))
    expect(router.history.length).toBe(1)
  })
})
