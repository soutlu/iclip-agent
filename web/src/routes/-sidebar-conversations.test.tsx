import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { addMockCollection, addMockConversation, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SidebarConversations } from './-sidebar-conversations'

/** 造 n 段对话，越靠后越新（一分钟一档，列表按最近活动倒序）。 */
const seedConversations = (count: number, collectionId: string | null = null) =>
  Array.from({ length: count }, (_, index) => {
    const conversation = addMockConversation(
      `第${index}段`,
      new Date(Date.UTC(2026, 7, 29, 0, index)).toISOString(),
    )
    conversation.collectionId = collectionId
    return conversation
  })

const render = async () => {
  server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))
  const user = userEvent.setup()
  await renderWithProviders(<SidebarConversations />)
  return user
}

describe('SidebarConversations', () => {
  it('筛选 chip：全部选中，另外两个后端还没有字段，先摆着点不动', async () => {
    await render()

    expect(await screen.findByRole('radio', { name: '全部' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '进行中' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '已完成' })).toBeDisabled()
  })

  it('任务区：第一页 20 条，点「展开显示」把剩下的接上来', async () => {
    seedConversations(21)
    const user = await render()

    // 标题上的数字是总数，与这一页给了几条无关
    expect(await screen.findByRole('button', { name: '任务 (21)' })).toBeVisible()
    expect(screen.getAllByRole('button', { name: /^第\d+段$/ })).toHaveLength(20)

    await user.click(screen.getByRole('button', { name: '展开显示更多对话' }))

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^第\d+段$/ })).toHaveLength(21),
    )
    // 没有更多了，那一行就不再出现
    expect(screen.queryByRole('button', { name: '展开显示更多对话' })).not.toBeInTheDocument()
  })

  it('合集内：第一页 10 段，展开后接上第 11 段', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    seedConversations(11, collection.id)
    const user = await render()

    await user.click(await screen.findByRole('button', { name: '夏季亚麻系列 (11)' }))
    expect(screen.getAllByRole('button', { name: /^第\d+段$/ })).toHaveLength(10)

    await user.click(screen.getByRole('button', { name: /展开显示 夏季亚麻系列/ }))

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^第\d+段$/ })).toHaveLength(11),
    )
  })

  it('合集列表本身也分段：先 10 个，展开再露一批', async () => {
    Array.from({ length: 12 }, (_, index) => addMockCollection(`合集${index}`))
    const user = await render()

    expect(await screen.findByRole('button', { name: '合集 (12)' })).toBeVisible()
    expect(screen.getAllByRole('button', { name: /^合集\d+ \(0\)$/ })).toHaveLength(10)

    await user.click(screen.getByRole('button', { name: '展开显示更多合集' }))

    expect(screen.getAllByRole('button', { name: /^合集\d+ \(0\)$/ })).toHaveLength(12)
    expect(screen.queryByRole('button', { name: '展开显示更多合集' })).not.toBeInTheDocument()
  })

  it('取更多失败时那一行变回「展开显示」，还能再点', async () => {
    seedConversations(21)
    server.use(
      http.get('*/api/conversations/ungrouped', () =>
        HttpResponse.json({ detail: '后端炸了' }, { status: 500 }),
      ),
    )
    const user = await render()
    const expand = await screen.findByRole('button', { name: '展开显示更多对话' })

    await user.click(expand)

    await waitFor(() => expect(expand).toBeEnabled())
    expect(expand).toBeVisible()
  })

  it('归属弹窗把对话移进合集后，侧栏跟着变', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    const [conversation] = seedConversations(1)
    const user = await render()
    await screen.findByText('第0段')

    await user.click(screen.getByRole('button', { name: '第0段 的归属' }))
    const dialog = await screen.findByRole('dialog', { name: '对话归属' })
    await user.selectOptions(within(dialog).getByLabelText('合集'), collection.id)
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(conversation?.collectionId).toBe(collection.id))
    expect(await screen.findByRole('button', { name: '任务 (0)' })).toBeVisible()
    expect(await screen.findByRole('button', { name: '夏季亚麻系列 (1)' })).toBeVisible()
  })
})
