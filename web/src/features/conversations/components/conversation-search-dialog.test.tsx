import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { addMockConversation } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ConversationSearchDialog } from './conversation-search-dialog'

const openDialog = () =>
  renderWithProviders(<ConversationSearchDialog onOpenChange={vi.fn()} open />)

describe('ConversationSearchDialog', () => {
  it('输入关键词后列出标题命中的对话，最近的排前面', async () => {
    // 按旧到新顺序插入，验证服务端仍按最近活动倒序返回。
    addMockConversation('夏季亚麻系列广告', '2026-08-01T00:00:00Z')
    addMockConversation('通勤背包短视频', '2026-08-02T00:00:00Z')
    addMockConversation('亚麻衬衫二剪', '2026-08-03T00:00:00Z')
    const user = userEvent.setup()
    await openDialog()

    expect(screen.getByText('输入关键词搜索你的对话')).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: '搜索对话' }), '亚麻')

    const results = await screen.findByRole('list', { name: '搜索结果' })
    expect(
      within(results)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['亚麻衬衫二剪', '夏季亚麻系列广告'])
  })

  it('没有命中时给一句空结果提示', async () => {
    addMockConversation('通勤背包短视频')
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
