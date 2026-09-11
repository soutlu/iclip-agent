import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { Conversation } from '../conversations.api'
import { ConversationSearchDialog } from './conversation-search-dialog'

const conversation: Conversation = {
  activity: { busy: false, lastTurnReason: null, pendingInteraction: 'none' },
  agentId: 'storyboard',
  collectionId: null,
  createdAt: '2026-08-01T00:00:00Z',
  id: '6d80645b-f17b-4eab-a5d2-6c72214f35f3',
  lastRunId: null,
  ownerUserId: '0f7f4c1e-8a3b-4d0e-9c2a-6b1d2e3f4a5b',
  taskId: null,
  title: '亚麻衬衫二剪',
  updatedAt: '2026-08-03T00:00:00Z',
}

const openDialog = () =>
  renderWithProviders(<ConversationSearchDialog onOpenChange={vi.fn()} open />)

describe('ConversationSearchDialog', () => {
  it('把关键词交给搜索接口，按响应顺序展示结果', async () => {
    let keyword: string | null = null
    server.use(
      http.get('*/api/conversations/search', ({ request }) => {
        keyword = new URL(request.url).searchParams.get('q')
        return HttpResponse.json({
          items: [
            conversation,
            {
              ...conversation,
              id: 'd47f7c54-7f89-44b5-aec7-647c019e6efe',
              title: '夏季亚麻系列广告',
              updatedAt: '2026-08-01T00:00:00Z',
            },
          ],
        })
      }),
    )
    const user = userEvent.setup()
    await openDialog()

    expect(screen.getByText('输入关键词搜索你的对话')).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: '搜索对话' }), '  亚麻  ')

    const results = await screen.findByRole('list', { name: '搜索结果' })
    expect(keyword).toBe('亚麻')
    expect(
      within(results)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['亚麻衬衫二剪', '夏季亚麻系列广告'])
  })

  it('没有命中时给一句空结果提示', async () => {
    server.use(http.get('*/api/conversations/search', () => HttpResponse.json({ items: [] })))
    const user = userEvent.setup()
    await openDialog()

    await user.type(screen.getByRole('textbox', { name: '搜索对话' }), '亚麻')

    expect(await screen.findByText('没有匹配的对话')).toBeVisible()
  })

  it('接口出错时把后端的错误文案就地显示出来', async () => {
    server.use(
      http.get('*/api/conversations/search', () =>
        HttpResponse.json({ detail: '搜索服务不可用' }, { status: 503 }),
      ),
    )
    const user = userEvent.setup()
    await openDialog()

    await user.type(screen.getByRole('textbox', { name: '搜索对话' }), '亚麻')

    expect(await screen.findByText(/搜索服务不可用/)).toBeVisible()
  })
})
