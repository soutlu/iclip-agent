import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TasksRoute } from '@/features/tasks'
import {
  addMockConversation,
  addMockTask,
  loginAs,
  mockAuthUser,
  mockGovernor,
} from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SERVER_HELLO } from '@/testing/ws'
import { TaskRelatedConversations } from './-task-related-conversations'

const renderTasks = async (currentUser = mockAuthUser) => {
  loginAs(currentUser)
  server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [] })))
  return renderWithProviders(
    <TasksRoute relatedContent={(taskId) => <TaskRelatedConversations taskId={taskId} />} />,
  )
}

const openTask = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  const all = await screen.findByRole('region', { name: '全部需求单' })
  await user.click(await within(all).findByRole('button', { name: `查看需求：${title}` }))
  return screen.findByRole('dialog', { name: title })
}

describe('需求单关联对话与视频', () => {
  it('详情默认展示面板，折叠和展开保留未保存表单，重新打开详情恢复面板', async () => {
    const task = addMockTask('夏季口播视频')
    const conversation = addMockConversation('口播创作尝试')
    conversation.taskId = task.id
    const user = userEvent.setup()
    await renderTasks()

    const dialog = await openTask(user, task.title)
    const panel = await within(dialog).findByRole('complementary', { name: '关联对话与视频' })
    expect(await within(panel).findByRole('heading', { name: conversation.title })).toBeVisible()
    await user.type(within(dialog).getByLabelText('创作要求'), '补充尚未保存的口播要求')

    await user.click(within(panel).getByRole('button', { name: '收起关联对话与视频' }))
    expect(within(dialog).queryByRole('complementary')).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText('创作要求')).toHaveValue('补充尚未保存的口播要求')
    await user.click(within(dialog).getByRole('button', { name: '打开关联对话与视频' }))
    expect(await within(dialog).findByRole('complementary')).toBeVisible()
    expect(within(dialog).getByLabelText('创作要求')).toHaveValue('补充尚未保存的口播要求')

    await user.click(within(dialog).getByRole('button', { name: '收起关联对话与视频' }))
    await user.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const reopened = await openTask(user, task.title)
    expect(
      await within(reopened).findByRole('complementary', { name: '关联对话与视频' }),
    ).toBeVisible()
  })

  it('新建需求单没有关联面板，也不发起关联查询', async () => {
    const requestedPaths: string[] = []
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname
      if (path.startsWith('/api/conversations') || path === '/api/generations') {
        requestedPaths.push(path)
      }
    })
    const user = userEvent.setup()
    await renderTasks()

    await user.click(await screen.findByRole('button', { name: '新建需求单' }))
    const dialog = await screen.findByRole('dialog', { name: '新建需求单' })
    expect(within(dialog).getByLabelText('需求单名称')).toBeVisible()
    expect(within(dialog).queryByRole('complementary')).not.toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: '打开关联对话与视频' }),
    ).not.toBeInTheDocument()
    expect(requestedPaths).toEqual([])
  })

  it.each([
    ['agent:read', '当前账号没有查看关联对话的权限'],
    ['generation:read', '当前账号没有查看视频的权限'],
  ])('缺少 %s 时显示权限说明且不请求受限数据', async (permission, message) => {
    const task = addMockTask('权限范围内的需求单')
    const conversation = addMockConversation('权限范围内的对话')
    conversation.taskId = task.id
    const requestedPaths: string[] = []
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname
      if (path.startsWith('/api/conversations') || path === '/api/generations') {
        requestedPaths.push(path)
      }
    })
    const user = userEvent.setup()
    await renderTasks({
      ...mockAuthUser,
      permissions: mockAuthUser.permissions.filter((item) => item !== permission),
    })

    const dialog = await openTask(user, task.title)
    const panel = await within(dialog).findByRole('complementary')
    expect(await within(panel).findByText(message)).toBeVisible()
    if (permission === 'agent:read') {
      expect(requestedPaths).toEqual([])
      expect(within(panel).queryByRole('heading', { name: conversation.title })).toBeNull()
    } else {
      expect(within(panel).getByRole('heading', { name: conversation.title })).toBeVisible()
      expect(requestedPaths).toEqual([`/api/conversations/by-task/${task.id}`])
    }
  })

  it('关联对话加载失败显示重试，成功重试后展示对话', async () => {
    const task = addMockTask('需要重试的需求单')
    const conversation = addMockConversation('重试后可见的对话')
    conversation.taskId = task.id
    let failed = true
    server.use(
      http.get('*/api/conversations/by-task/:taskId', () =>
        failed
          ? HttpResponse.json({ detail: '暂时无法读取对话' }, { status: 503 })
          : HttpResponse.json({ items: [conversation] }),
      ),
    )
    const user = userEvent.setup()
    await renderTasks()

    const dialog = await openTask(user, task.title)
    const panel = await within(dialog).findByRole('complementary')
    expect(await within(panel).findByRole('alert')).toHaveTextContent('关联对话加载失败')
    expect(within(panel).queryByText('你还没有关联到这张需求单的对话')).not.toBeInTheDocument()
    expect(within(panel).queryByText('暂无关联对话')).not.toBeInTheDocument()
    failed = false
    await user.click(within(panel).getByRole('button', { name: '重试' }))
    expect(await within(panel).findByRole('heading', { name: conversation.title })).toBeVisible()
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['普通用户', mockAuthUser, false],
    ['治理者', mockGovernor, true],
  ])('%s 按现有可见范围展示对话并提供打开入口', async (_role, currentUser, canAudit) => {
    const task = addMockTask('多人协作的需求单')
    const own = addMockConversation('我的创作尝试')
    own.taskId = task.id
    const other = addMockConversation('同事的创作尝试', undefined, mockGovernor.id)
    other.taskId = task.id
    const unrelated = addMockConversation('其他需求单的对话')
    unrelated.taskId = crypto.randomUUID()
    const user = userEvent.setup()
    await renderTasks(currentUser)

    const dialog = await openTask(user, task.title)
    const panel = await within(dialog).findByRole('complementary')
    expect(await within(panel).findByRole('heading', { name: own.title })).toBeVisible()
    expect(
      within(panel).getByRole('link', { name: `打开对话：${own.title}（新标签页）` }),
    ).toHaveAttribute('href', `/c/${own.id}`)
    expect(within(panel).queryByRole('heading', { name: unrelated.title })).not.toBeInTheDocument()
    if (canAudit) {
      expect(within(panel).getByRole('heading', { name: other.title })).toBeVisible()
      expect(within(panel).queryByText('仅我的对话')).not.toBeInTheDocument()
    } else {
      expect(within(panel).queryByRole('heading', { name: other.title })).not.toBeInTheDocument()
      expect(within(panel).getByText('仅我的对话')).toBeVisible()
    }
  })
})

describe('需求单关联对话按全局帧重拉', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const videoFrame = (conversationId: string, kind: 'video' | 'image' = 'video') => ({
    type: 'event.generation.changed',
    session_id: conversationId,
    payload: {
      id: crypto.randomUUID(),
      kind,
      operation: 'generate',
      status: 'pending',
      metadata: { shot: 1 },
    },
  })

  /** 打开一张挂着一段空闲对话的需求单，并记下关联对话列表被读了几次。 */
  const openWithConversation = async (currentUser = mockAuthUser) => {
    const task = addMockTask('空闲时被提交出片的需求单')
    const conversation = addMockConversation('空闲的创作尝试', undefined, mockAuthUser.id)
    conversation.taskId = task.id
    const listPath =
      currentUser === mockGovernor ? '/api/conversations/audit' : '/api/conversations/by-task/'
    const reads = { count: 0 }
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname.startsWith(listPath)) reads.count += 1
    })
    const user = userEvent.setup()
    const { socket } = await renderTasks(currentUser)
    const dialog = await openTask(user, task.title)
    const row = await within(dialog).findByRole('region', { name: conversation.title })
    expect(reads.count).toBe(1)
    return { conversation, reads, row, socket }
  }

  /** 留出一次真实请求往返的时间，否则「没重拉」是空断言。 */
  const roundTrip = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

  it.each([
    ['属主', mockAuthUser],
    ['治理者看别人的对话', mockGovernor],
  ])('%s：列表里对话的出片帧重拉列表，行上出现出片角标', async (_role, currentUser) => {
    const { conversation, reads, row, socket } = await openWithConversation(currentUser)
    expect(within(row).queryByText('排队中')).not.toBeInTheDocument()
    conversation.activity.videoGeneration = 'queued'

    act(() => socket.deliver(videoFrame(conversation.id)))

    expect(await within(row).findByText('排队中')).toBeVisible()
    expect(reads.count).toBe(2)
  })

  it('不在列表里的对话、列表里对话的图片帧都不重拉', async () => {
    const { conversation, reads, row, socket } = await openWithConversation()

    act(() => socket.deliver(videoFrame(crypto.randomUUID())))
    act(() => socket.deliver(videoFrame(conversation.id, 'image')))
    await roundTrip()
    expect(reads.count).toBe(1)

    conversation.activity.videoGeneration = 'queued'
    act(() => socket.deliver(videoFrame(conversation.id)))
    expect(await within(row).findByText('排队中')).toBeVisible()
    expect(reads.count).toBe(2)
  })

  it('重连后重拉列表', async () => {
    const { reads, socket } = await openWithConversation()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    socket.onclose?.()
    // 退避重连排在定时器上，推过去才会重新握手。
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    vi.useRealTimers()
    act(() => socket.deliver(SERVER_HELLO))

    await waitFor(() => expect(reads.count).toBe(2))
  })
})
