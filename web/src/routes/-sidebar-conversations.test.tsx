import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { addMockCollection, addMockConversation, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SidebarConversations } from './-sidebar-conversations'

/** 按分钟递增活动时间，验证列表倒序。 */
const seedConversations = (count: number, collectionId: string | null = null) =>
  Array.from({ length: count }, (_, index) => {
    const conversation = addMockConversation(
      `第${index}段`,
      new Date(Date.UTC(2026, 7, 29, 0, index)).toISOString(),
    )
    conversation.collectionId = collectionId
    return conversation
  })

/** session_id 位于信封；运行帧省略 last_turn_reason。 */
const workChanged = (
  conversationId: string,
  payload: {
    busy: boolean
    last_turn_reason?: 'completed' | 'failed' | 'aborted'
    pending_interaction?: 'none' | 'approval' | 'question'
  },
) => ({
  type: 'event.session.work_changed',
  session_id: conversationId,
  payload: { pending_interaction: 'none', ...payload },
})

const render = async (initialPath = '/') => {
  server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))
  const user = userEvent.setup()
  const { router, socket } = await renderWithProviders(<SidebarConversations />, { initialPath })
  return { router, socket, user }
}

describe('SidebarConversations', () => {
  it('筛选片接线到服务端：进行中只剩在跑的，已完成只剩跑完的', async () => {
    addMockConversation('还没跑过', new Date(Date.UTC(2026, 7, 29, 0, 0)).toISOString())
    const running = addMockConversation('在跑', new Date(Date.UTC(2026, 7, 29, 0, 1)).toISOString())
    const done = addMockConversation('跑完了', new Date(Date.UTC(2026, 7, 29, 0, 2)).toISOString())
    running.activity = { busy: true, lastTurnReason: null, pendingInteraction: 'none' }
    done.activity = { busy: false, lastTurnReason: 'completed', pendingInteraction: 'none' }
    // 记录实际请求，验证筛选参数传递到服务端。
    const listed: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/api/conversations?')) listed.push(request.url)
    })
    const { user } = await render()

    expect(await screen.findByRole('button', { name: '任务 (3)' })).toBeVisible()

    await user.click(screen.getByRole('radio', { name: '进行中' }))

    expect(await screen.findByRole('link', { name: '在跑' })).toBeVisible()
    expect(await screen.findByRole('button', { name: '任务 (1)' })).toBeVisible()
    expect(screen.queryByRole('link', { name: '跑完了' })).not.toBeInTheDocument()
    expect(listed.at(-1)).toContain('state=running')

    await user.click(screen.getByRole('radio', { name: '已完成' }))

    expect(await screen.findByRole('link', { name: '跑完了' })).toBeVisible()
    expect(screen.queryByRole('link', { name: '在跑' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '还没跑过' })).not.toBeInTheDocument()
    expect(listed.at(-1)).toContain('state=done')
  })

  it('任务区：第一页 20 条，点「展开显示」把剩下的接上来', async () => {
    seedConversations(21)
    const { user } = await render()

    expect(await screen.findByRole('button', { name: '任务 (21)' })).toBeVisible()
    expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(20)

    await user.click(screen.getByRole('button', { name: '展开显示更多对话' }))

    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(21))
    expect(screen.queryByRole('button', { name: '展开显示更多对话' })).not.toBeInTheDocument()
  })

  it('合集内：第一页 10 段，展开后接上第 11 段', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    seedConversations(11, collection.id)
    const { user } = await render()

    await user.click(await screen.findByRole('button', { name: '夏季亚麻系列 (11)' }))
    expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(10)

    await user.click(screen.getByRole('button', { name: /展开显示 夏季亚麻系列/ }))

    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(11))
  })

  it('合集列表本身也分段：先 10 个，展开再露一批', async () => {
    Array.from({ length: 12 }, (_, index) => addMockCollection(`合集${index}`))
    const { user } = await render()

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
    const { user } = await render()
    const expand = await screen.findByRole('button', { name: '展开显示更多对话' })

    await user.click(expand)

    await waitFor(() => expect(expand).toBeEnabled())
    expect(expand).toBeVisible()
  })

  it('归属弹窗把对话移进合集后，侧栏跟着变', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    const [conversation] = seedConversations(1)
    const { user } = await render()
    await screen.findByText('第0段')

    await user.click(screen.getByRole('button', { name: '第0段 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '归属' }))
    const dialog = await screen.findByRole('dialog', { name: '对话归属' })
    await user.selectOptions(within(dialog).getByLabelText('合集'), collection.id)
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(conversation?.collectionId).toBe(collection.id))
    expect(await screen.findByRole('button', { name: '任务 (0)' })).toBeVisible()
    expect(await screen.findByRole('button', { name: '夏季亚麻系列 (1)' })).toBeVisible()
  })

  it('服务端给对话起了名，侧栏那一行当场跟着改', async () => {
    const [conversation] = seedConversations(1)
    const { socket } = await render()
    await screen.findByText('第0段')

    socket.deliver({
      type: 'session.meta.updated',
      payload: { session_id: conversation?.id ?? '', title: '夜景延时素材生成' },
    })

    expect(await screen.findByText('夜景延时素材生成')).toBeVisible()
    expect(screen.queryByText('第0段')).not.toBeInTheDocument()
  })

  it('服务端说这段对话跑起来了，那一行就转圈；跑完了转圈收掉', async () => {
    const [conversation] = seedConversations(1)
    const { socket } = await render()
    await screen.findByText('第0段')

    expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument()

    socket.deliver(workChanged(conversation?.id ?? '', { busy: true }))
    expect(await screen.findByLabelText('进行中')).toBeVisible()

    socket.deliver(workChanged(conversation?.id ?? '', { busy: false }))
    await waitFor(() => expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument())
  })

  it('行尾状态跟着帧上的活儿换：等审批、上次失败，跑完了什么都不画', async () => {
    const [conversation] = seedConversations(1)
    const id = conversation?.id ?? ''
    const { socket } = await render()
    await screen.findByText('第0段')

    socket.deliver(workChanged(id, { busy: true, pending_interaction: 'approval' }))
    expect(await screen.findByLabelText('等待审批')).toBeVisible()
    expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument()

    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'failed' }))
    expect(await screen.findByLabelText('上次失败')).toBeVisible()

    // 同步更新 MSW 列表状态，使推送后的重拉返回一致事实。
    if (conversation !== undefined) {
      conversation.activity = {
        busy: false,
        lastTurnReason: 'completed',
        pendingInteraction: 'none',
      }
    }
    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'completed' }))
    await waitFor(() => expect(screen.queryByLabelText('上次失败')).not.toBeInTheDocument())
    expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('未读')).not.toBeInTheDocument()
  })

  it('从没打开过的对话不画未读点：行上带的 completed 与收场帧都不算', async () => {
    const done = addMockConversation('跑完了')
    done.lastRunId = 'run-1'
    done.activity = { busy: false, lastTurnReason: 'completed', pendingInteraction: 'none' }
    const { socket } = await render()
    await screen.findByText('跑完了')

    expect(screen.queryByLabelText('未读')).not.toBeInTheDocument()

    socket.deliver(workChanged(done.id, { busy: false, last_turn_reason: 'completed' }))
    await waitFor(() => expect(screen.queryByLabelText('未读')).not.toBeInTheDocument())
  })

  it('看着它闲下来之后走开，它又跑完一次：那一行画点，打开就灭', async () => {
    const [conversation] = seedConversations(1)
    const id = conversation?.id ?? ''
    const { router, socket } = await render(`/c/${id}`)
    await screen.findByText('第0段')
    expect(screen.queryByLabelText('未读')).not.toBeInTheDocument()

    await act(() => router.navigate({ to: '/' }))
    // 模拟离开后产生新 lastRunId，再通过结束帧触发列表刷新。
    if (conversation !== undefined) {
      conversation.lastRunId = 'run-2'
      conversation.activity = {
        busy: false,
        lastTurnReason: 'completed',
        pendingInteraction: 'none',
      }
    }
    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'completed' }))
    expect(await screen.findByLabelText('未读')).toBeVisible()

    await act(() => router.navigate({ params: { conversationId: id }, to: '/c/$conversationId' }))
    await waitFor(() => expect(screen.queryByLabelText('未读')).not.toBeInTheDocument())
  })

  it('打开着的对话在折叠的合集里、那一行没渲染出来，照样记得住：展开之后点在', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    const [conversation] = seedConversations(1, collection.id)
    const id = conversation?.id ?? ''
    const { router, socket, user } = await render(`/c/${id}`)
    await screen.findByRole('button', { name: '夏季亚麻系列 (1)' })
    expect(screen.queryByText('第0段')).not.toBeInTheDocument()

    await act(() => router.navigate({ to: '/' }))
    if (conversation !== undefined) {
      conversation.lastRunId = 'run-2'
      conversation.activity = {
        busy: false,
        lastTurnReason: 'completed',
        pendingInteraction: 'none',
      }
    }
    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'completed' }))

    await user.click(screen.getByRole('button', { name: '夏季亚麻系列 (1)' }))
    expect(await screen.findByText('第0段')).toBeVisible()
    expect(await screen.findByLabelText('未读')).toBeVisible()
  })

  it('「展开显示」接上来的那一行收到帧也跟着转圈', async () => {
    const rows = seedConversations(21)
    const { socket, user } = await render()

    await user.click(await screen.findByRole('button', { name: '展开显示更多对话' }))
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(21))

    // 最旧对话位于展开加载的额外分页中。
    socket.deliver(workChanged(rows[0]?.id ?? '', { busy: true }))

    expect(await screen.findByLabelText('进行中')).toBeVisible()
  })

  it('筛「进行中」时一段对话收场，重拉之后它不在这一档里了', async () => {
    const conversation = addMockConversation('在跑')
    conversation.activity = { busy: true, lastTurnReason: null, pendingInteraction: 'none' }
    const { socket, user } = await render()

    await user.click(await screen.findByRole('radio', { name: '进行中' }))
    expect(await screen.findByRole('link', { name: '在跑' })).toBeVisible()

    conversation.activity = { busy: false, lastTurnReason: 'completed', pendingInteraction: 'none' }
    socket.deliver(workChanged(conversation.id, { busy: false, last_turn_reason: 'completed' }))

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: '在跑' })).not.toBeInTheDocument(),
    )
  })
})
