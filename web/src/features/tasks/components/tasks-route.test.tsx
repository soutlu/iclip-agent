import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockAuthUser, mockTasks } from '@/testing/mocks/handlers'
import { renderWithProviders } from '@/testing/render'
import { TasksRoute } from './tasks-route'

// 通过 MSW 登录设置会话，保持 /users/me 路径与实际应用一致。
const login = async () => {
  await fetch('/api/auth/login', {
    body: new URLSearchParams({ password: 'x', username: 'tester' }),
    method: 'POST',
  })
}

const makeTask = (overrides: Partial<(typeof mockTasks)[number]>) => ({
  assigneeUserIds: [],
  brief: {
    audience: '',
    color: '',
    contentType: '',
    department: '',
    durationSeconds: null,
    language: '',
    platform: '',
    purpose: '',
    referenceImages: [],
    referenceVideos: [],
    requester: '',
    requirementDescription: '',
    scene: '',
    selling: '',
    styleNos: ['SBPU24001W'],
    theme: '',
    videoType: '',
  },
  createdAt: new Date().toISOString(),
  creatorUserId: mockAuthUser.id,
  deadline: null,
  id: crypto.randomUUID(),
  priority: 0,
  status: 'draft',
  style: { brand: '', category: '', previewImageUrl: '', styleNo: 'SBPU24001W' },
  title: '未命名需求单',
  updatedAt: new Date().toISOString(),
  ...overrides,
})

const renderLoggedIn = async () => {
  await login()
  return renderWithProviders(<TasksRoute />)
}

describe('TasksRoute', () => {
  it('渲染两个分区与卡片', async () => {
    mockTasks.push(
      makeTask({ status: 'published', title: '夏季新品视频' }),
      makeTask({
        assigneeUserIds: [mockAuthUser.id],
        status: 'confirmed',
        title: '我认领的需求单',
      }),
    )
    await renderLoggedIn()

    expect(await screen.findByText('夏季新品视频')).toBeVisible()
    expect(screen.getAllByText('我认领的需求单')).toHaveLength(2)

    const mine = screen.getByRole('region', { name: '我的需求单' })
    expect(within(mine).getByText('我认领的需求单')).toBeVisible()
    expect(within(mine).queryByText('夏季新品视频')).not.toBeInTheDocument()
  })

  it('新建弹窗创建需求单后出现在列表', async () => {
    const user = userEvent.setup()
    await renderLoggedIn()

    await user.click(await screen.findByRole('button', { name: '新建需求单' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('需求单名称'), '新品测评视频')
    await user.type(within(dialog).getByLabelText('主款号'), 'SBPU24001W')
    await user.click(within(dialog).getByRole('button', { name: '确定' }))

    expect(await screen.findByText('新品测评视频')).toBeVisible()
  })

  it('认领 published 需求单后出现在我的需求单', async () => {
    mockTasks.push(makeTask({ status: 'published', title: '待认领的需求单' }))
    const user = userEvent.setup()
    await renderLoggedIn()

    await user.click(await screen.findByText('待认领的需求单'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '认领' }))

    const mine = screen.getByRole('region', { name: '我的需求单' })
    await waitFor(() => expect(within(mine).getByText('待认领的需求单')).toBeVisible())
  })

  it('详情弹窗补充需求描述后保存', async () => {
    const task = makeTask({
      assigneeUserIds: [mockAuthUser.id],
      status: 'confirmed',
      title: '进行中的需求单',
    })
    mockTasks.push(task)
    const user = userEvent.setup()
    await renderLoggedIn()

    const mine = screen.getByRole('region', { name: '我的需求单' })
    await user.click(await within(mine).findByText('进行中的需求单'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('需求描述'), '补充：要 15 秒版本')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mockTasks[0]?.brief['requirementDescription']).toBe('补充：要 15 秒版本'),
    )
  })

  it('我的需求单卡片菜单里重命名需求单', async () => {
    const task = makeTask({
      assigneeUserIds: [mockAuthUser.id],
      status: 'confirmed',
      title: '进行中的需求单',
    })
    mockTasks.push(task)
    const user = userEvent.setup()
    await renderLoggedIn()

    const all = screen.getByRole('region', { name: '全部需求单' })
    await within(all).findByText('进行中的需求单')
    expect(within(all).queryByRole('button', { name: '更多操作' })).toBeNull()

    const mine = screen.getByRole('region', { name: '我的需求单' })
    await user.click(await within(mine).findByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))

    const dialog = await screen.findByRole('dialog', { name: '重命名需求单' })
    const input = within(dialog).getByLabelText('新的需求单名称')
    await user.clear(input)
    await user.type(input, '改名后的需求单')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(task.title).toBe('改名后的需求单'))
    expect(await within(mine).findByText('改名后的需求单')).toBeVisible()
  })
})
