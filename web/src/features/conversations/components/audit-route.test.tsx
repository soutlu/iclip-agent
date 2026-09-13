import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addMockConversation,
  addMockTask,
  addMockUser,
  mockAuthUser,
} from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { useLiveConversations } from '../conversations.live'
import { AuditRoute } from './audit-route'

/** 全局帧订阅在应用里挂在侧栏顶层；页面自己不订，这里照壳的样子在外面挂一次。 */
function LiveFrames() {
  useLiveConversations()
  return null
}

const RUNNING = { busy: true, lastTurnReason: null, pendingInteraction: 'none' } as const
const COMPLETED = { busy: false, lastTurnReason: 'completed', pendingInteraction: 'none' } as const

/** session_id 位于信封；运行帧省略 last_turn_reason。 */
const workChanged = (
  conversationId: string,
  payload: { busy: boolean; last_turn_reason?: 'completed' | 'failed' | 'aborted' },
) => ({
  type: 'event.session.work_changed',
  session_id: conversationId,
  payload: { pending_interaction: 'none', ...payload },
})

const render = async (tasks: readonly { id: string; label: string }[] = []) => {
  server.use(
    http.get('*/api/users/me', () =>
      HttpResponse.json({
        user: { ...mockAuthUser, permissions: [...mockAuthUser.permissions, 'users:manage'] },
      }),
    ),
  )
  const user = userEvent.setup()
  const rendered = await renderWithProviders(
    <>
      <LiveFrames />
      <AuditRoute tasks={tasks} />
    </>,
  )
  return { ...rendered, user }
}

const rowOf = (title: string) => screen.findByRole('link', { name: new RegExp(title) })

const expectTotals = (running: number, total: number) => {
  const totals = screen.getByRole('status', { name: '对话总数' })
  expect(totals).toHaveTextContent(`${running} 进行中`)
  expect(totals).toHaveTextContent(`${total} 段`)
}

/** 三段对话：别人在跑的、自己没跑过的、别人跑完的。 */
const seedThree = () => {
  const other = addMockUser('小王')
  const task = addMockTask('秋季新品')
  const theirs = addMockConversation('小王的秋季片', '2026-09-02T00:00:00Z')
  theirs.ownerUserId = other.id
  theirs.taskId = task.id
  theirs.activity = RUNNING
  addMockConversation('我的片', '2026-09-01T00:00:00Z')
  const done = addMockConversation('跑完的片', '2026-08-30T00:00:00Z')
  done.ownerUserId = other.id
  done.activity = COMPLETED
  done.lastRunId = 'run-1'
  return { other, task, theirs }
}

beforeEach(() => {
  // Radix 通过 ResizeObserver 测量浮层箭头；jsdom 的几何行为由浏览器验收补足。
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuditRoute', () => {
  it('按最近活动倒序列出全平台对话，保留用户、已关联需求单与运行总数', async () => {
    const { task } = seedThree()
    await render([{ id: task.id, label: task.title }])

    const list = within(await screen.findByRole('list'))
    expect(list.getAllByRole('link').map((link) => link.textContent)).toEqual([
      expect.stringContaining('小王的秋季片'),
      expect.stringContaining('我的片'),
      expect.stringContaining('跑完的片'),
    ])
    const theirs = await rowOf('小王的秋季片')
    expect(theirs).toHaveTextContent('进行中')
    expect(await within(theirs).findByText('小王')).toBeVisible()
    expect(theirs).toHaveTextContent('秋季新品')
    expect(await rowOf('我的片')).toHaveTextContent('测试用户')
    expect(await rowOf('跑完的片')).toHaveTextContent('已完成')
    expectTotals(1, 3)
  })

  it('关闭用户浮层后立即重开时清空临时搜索词，重新展示完整候选', async () => {
    seedThree()
    const { user } = await render()
    await rowOf('我的片')
    const trigger = screen.getByRole('button', { name: '用户：用户' })

    await user.click(trigger)
    await user.type(await screen.findByRole('combobox', { name: '搜索用户' }), '小王')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Escape}')
    await user.click(trigger)

    expect(await screen.findByRole('combobox', { name: '搜索用户' })).toHaveValue('')
    expect(screen.getByRole('option', { name: '测试用户' })).toBeVisible()
    expect(screen.getByRole('option', { name: '小王' })).toBeVisible()
    expect(screen.getByRole('option', { name: '治理者' })).toBeVisible()
  })

  it('切「已完成」交给服务端筛：只剩跑完的，总数跟着变，在跑数不变', async () => {
    seedThree()
    const { user } = await render()
    await rowOf('小王的秋季片')

    await user.click(screen.getByRole('radio', { name: '已完成' }))

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /小王的秋季片/ })).not.toBeInTheDocument(),
    )
    expect(await rowOf('跑完的片')).toBeVisible()
    expect(screen.queryByRole('link', { name: /我的片/ })).not.toBeInTheDocument()
    expectTotals(1, 1)
  })

  it('选择用户后关闭浮层并返回触发器，再次选择当前用户清除筛选', async () => {
    seedThree()
    const { user } = await render()
    await rowOf('我的片')

    await user.click(screen.getByRole('button', { name: '用户：用户' }))
    const picker = await screen.findByRole('dialog', { name: '选择用户' })
    await user.click(await within(picker).findByRole('option', { name: '小王' }))

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /我的片/ })).not.toBeInTheDocument(),
    )
    expect(await rowOf('小王的秋季片')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const selectedTrigger = screen.getByRole('button', { name: '用户：小王' })
    await waitFor(() => expect(selectedTrigger).toHaveFocus())
    expectTotals(1, 2)

    await user.click(selectedTrigger)
    const selectedOption = await screen.findByRole('option', { name: '小王', selected: true })
    await user.click(selectedOption)

    expect(await rowOf('我的片')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '用户：用户' })).toHaveFocus())
    expect(within(screen.getByRole('list')).getAllByRole('link')).toHaveLength(3)
    expectTotals(1, 3)
  })

  it('搜索并选择需求单后只保留关联对话，触发器展示已应用条件', async () => {
    const { task } = seedThree()
    const otherTask = addMockTask('夏季亚麻系列')
    const { user } = await render([
      { id: task.id, label: task.title },
      { id: otherTask.id, label: otherTask.title },
    ])
    await rowOf('我的片')

    await user.click(screen.getByRole('button', { name: '需求单：需求单' }))
    const picker = await screen.findByRole('dialog', { name: '选择需求单' })
    await user.type(within(picker).getByRole('combobox', { name: '搜索需求单' }), '秋季')
    expect(within(picker).getAllByRole('option')).toHaveLength(1)
    await user.click(within(picker).getByRole('option', { name: '秋季新品' }))

    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('link')).toHaveLength(1),
    )
    expect(await rowOf('小王的秋季片')).toBeVisible()
    expect(screen.queryByRole('link', { name: /跑完的片/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '需求单：秋季新品' })).toHaveFocus(),
    )
    expectTotals(1, 1)
  })

  it('切换筛选触发器时只保留一个浮层，Escape 关闭并将焦点归还当前触发器', async () => {
    const { task } = seedThree()
    const { user } = await render([{ id: task.id, label: task.title }])
    await rowOf('我的片')

    await user.click(screen.getByRole('button', { name: '用户：用户' }))
    expect(await screen.findByRole('dialog', { name: '选择用户' })).toBeVisible()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '需求单：需求单' }))
    const taskPicker = await screen.findByRole('dialog', { name: '选择需求单' })
    expect(screen.queryByRole('dialog', { name: '选择用户' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await waitFor(() =>
      expect(within(taskPicker).getByRole('combobox', { name: '搜索需求单' })).toHaveFocus(),
    )

    const timeTrigger = screen.getByRole('button', { name: '时间：时间' })
    await user.click(timeTrigger)
    expect(await screen.findByRole('dialog', { name: '选择时间范围' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '选择需求单' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(timeTrigger).toHaveFocus())
  })

  it('用户名册读取失败时在浮层内呈现错误，重试恢复候选和对话上的用户名', async () => {
    seedThree()
    server.use(
      http.get(
        '*/api/users',
        () => HttpResponse.json({ detail: '用户名册暂不可用' }, { status: 503 }),
        { once: true },
      ),
    )
    const { user } = await render()
    const theirs = await rowOf('小王的秋季片')

    await user.click(screen.getByRole('button', { name: '用户：用户' }))
    const picker = await screen.findByRole('dialog', { name: '选择用户' })
    expect(await within(picker).findByRole('alert')).toBeVisible()
    expect(within(picker).queryAllByRole('option')).toHaveLength(0)
    await user.click(within(picker).getByRole('button', { name: '重新加载' }))

    expect(await within(picker).findByRole('option', { name: '小王' })).toBeVisible()
    expect(within(picker).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(picker).getByRole('combobox', { name: '搜索用户' })).toHaveFocus()
    expect(await within(theirs).findByText('小王')).toBeVisible()
  })

  it('别人对话的活动帧更新状态并重拉总数；没见过的 id 重拉后多出一行', async () => {
    const other = addMockUser('小王')
    const theirs = addMockConversation('小王的秋季片')
    theirs.ownerUserId = other.id
    const { socket } = await render()
    const initialRow = await rowOf('小王的秋季片')
    expect(initialRow).not.toHaveTextContent('进行中')
    expectTotals(0, 1)

    // 先改 MSW 里的事实，推送后的重拉才与就地补丁一致。
    theirs.activity = RUNNING
    socket.deliver(workChanged(theirs.id, { busy: true }))
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /小王的秋季片/ })).toHaveTextContent('进行中'),
    )
    await waitFor(() => expectTotals(1, 1))

    const fresh = addMockConversation('刚开的片')
    fresh.ownerUserId = other.id
    fresh.activity = RUNNING
    socket.deliver(workChanged(fresh.id, { busy: true }))
    expect(await rowOf('刚开的片')).toHaveTextContent('进行中')
    await waitFor(() => expectTotals(2, 2))
  })

  it('一页五十段，展开加载剩余对话后移除分页入口', async () => {
    for (let index = 0; index < 55; index += 1) {
      addMockConversation(`第${index}段`, new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString())
    }
    const { user } = await render()

    expect(await screen.findByText('已显示 50 / 55')).toBeVisible()
    expect(within(screen.getByRole('list')).getAllByRole('link')).toHaveLength(50)
    await user.click(screen.getByRole('button', { name: '展开显示更多对话' }))

    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('link')).toHaveLength(55),
    )
    expect(screen.queryByRole('button', { name: '展开显示更多对话' })).not.toBeInTheDocument()
    expect(screen.queryByText(/已显示/)).not.toBeInTheDocument()
    expectTotals(0, 55)
  })
})
