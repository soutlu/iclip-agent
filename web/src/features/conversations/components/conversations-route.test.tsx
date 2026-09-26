import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import {
  addMockConversation,
  addMockTask,
  addMockUser,
  loginAs,
  mockAuthUser,
} from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_AUDIT_FILTERS, type AuditFilters } from '../audit.api'
import { useLiveConversations } from '../conversations.live'
import { ConversationsRoute } from './conversations-route'

/** 全局帧订阅在应用里挂在侧栏顶层；页面自己不订，这里照壳的样子在外面挂一次。 */
function LiveFrames() {
  useLiveConversations()
  return null
}

const RUNNING = {
  busy: true,
  lastTurnReason: null,
  pendingInteraction: 'none',
  videoGeneration: 'none',
} as const
const COMPLETED = {
  busy: false,
  lastTurnReason: 'completed',
  pendingInteraction: 'none',
  videoGeneration: 'none',
} as const

/** session_id 位于信封；运行帧省略 last_turn_reason。 */
const workChanged = (
  conversationId: string,
  payload: { busy: boolean; last_turn_reason?: 'completed' | 'failed' | 'aborted' },
) => ({
  type: 'event.session.work_changed',
  session_id: conversationId,
  payload: { pending_interaction: 'none', ...payload },
})

/** 筛选条件在应用里由路由存在查询参数上；这里照样在外面持有一份，只测列表本身的行为。 */
function StatefulConversationsRoute({
  tasks,
  previews = new Map(),
}: {
  tasks: readonly { id: string; label: string }[]
  previews?: ReadonlyMap<string, { title: string; requirement: string; imageUrl: string | null }>
}) {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS)
  return (
    <ConversationsRoute
      taskPreviews={previews}
      taskPreviewState="ready"
      filters={filters}
      onFiltersChange={setFilters}
      tasks={{ error: undefined, isPending: false, onRetry: undefined, options: tasks }}
    />
  )
}

const render = async (tasks: readonly { id: string; label: string }[] = []) => {
  loginAs(mockAuthUser, { permissions: [...mockAuthUser.permissions, 'users:manage'] })
  const user = userEvent.setup()
  const rendered = await renderWithProviders(
    <>
      <LiveFrames />
      <StatefulConversationsRoute tasks={tasks} />
    </>,
  )
  return { ...rendered, user }
}

/** 等全局帧引起的重拉时放宽超时：那一路带一秒的去抖窗口（见 conversations.live.ts）。 */
const AUDIT_REFRESH_TIMEOUT = { timeout: 3000 }

const rowOf = (title: string, options?: { timeout: number }) =>
  screen.findByRole('link', { name: new RegExp(title) }, options)

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
  done.completedAt = '2026-08-31T00:00:00Z'
  return { other, task, theirs }
}

describe('ConversationsRoute', () => {
  it('按建立时间倒序列出全平台对话', async () => {
    const { task } = seedThree()
    await render([{ id: task.id, label: task.title }])

    const list = within(await screen.findByRole('list'))
    expect(list.getAllByRole('link').map((link) => link.textContent)).toEqual([
      expect.stringContaining('小王的秋季片'),
      expect.stringContaining('我的片'),
      expect.stringContaining('跑完的片'),
    ])
  })

  it('每行标出属主与运行状态', async () => {
    const { task } = seedThree()
    await render([{ id: task.id, label: task.title }])

    const theirs = await rowOf('小王的秋季片')
    expect(theirs).toHaveTextContent('进行中')
    expect(await within(theirs).findByText('小王')).toBeVisible()
    expect(await rowOf('我的片')).toHaveTextContent('测试用户')
    expect(await rowOf('跑完的片')).toHaveTextContent('已完成')
    expect(await rowOf('跑完的片')).toHaveTextContent('属主已收尾')
  })

  it('已关联的需求单标题挂在行上', async () => {
    const { task } = seedThree()
    await render([{ id: task.id, label: task.title }])

    expect(await rowOf('小王的秋季片')).toHaveTextContent('秋季新品')
  })

  it('顶部给出进行中与总数', async () => {
    const { task } = seedThree()
    await render([{ id: task.id, label: task.title }])

    await rowOf('小王的秋季片')
    expectTotals(1, 3)
  })

  it('空要求与图片失败分别展示空态，保留对话入口', async () => {
    const { task } = seedThree()
    await renderWithProviders(
      <StatefulConversationsRoute
        tasks={[{ id: task.id, label: task.title }]}
        previews={
          new Map([
            [
              task.id,
              { title: task.title, requirement: '', imageUrl: 'https://example.com/product.png' },
            ],
          ])
        }
      />,
    )
    const row = await rowOf('小王的秋季片')
    expect(row).toHaveTextContent('未填写创作要求')
    fireEvent.error(within(row).getByRole('img', { name: '秋季新品的需求素材' }))
    expect(row).toHaveTextContent('图片加载失败')
    expect(row).toHaveAttribute('href', expect.stringContaining('/c/'))
  })

  it('缺省不列已删的；切「已删除」只剩墓碑，行上标出删除时间', async () => {
    const { other } = seedThree()
    const gone = addMockConversation('删掉的片', '2026-09-03T00:00:00Z')
    gone.ownerUserId = other.id
    gone.deletedAt = '2026-09-04T00:00:00Z'
    const { user } = await render()
    await rowOf('小王的秋季片')
    expect(screen.queryByRole('link', { name: /删掉的片/ })).not.toBeInTheDocument()
    expectTotals(1, 3)

    await user.click(screen.getByRole('radio', { name: '已删除' }))

    const row = await rowOf('删掉的片')
    expect(row).toHaveTextContent('已删除 ·')
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /小王的秋季片/ })).not.toBeInTheDocument(),
    )
    expectTotals(0, 1)

    await user.click(screen.getByRole('radio', { name: '不限' }))
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('link')).toHaveLength(4),
    )
    expectTotals(1, 4)
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

  it('切「已完成」交给服务端筛：只剩属主标过的，总数跟着变，在跑数不变', async () => {
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

  it('从用户浮层切到需求单浮层：旧浮层关闭，焦点进需求单搜索框', async () => {
    const { task } = seedThree()
    const { user } = await render([{ id: task.id, label: task.title }])
    await rowOf('我的片')

    await user.click(screen.getByRole('button', { name: '用户：用户' }))
    expect(await screen.findByRole('dialog', { name: '选择用户' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '需求单：需求单' }))
    const taskPicker = await screen.findByRole('dialog', { name: '选择需求单' })
    expect(screen.queryByRole('dialog', { name: '选择用户' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(within(taskPicker).getByRole('combobox', { name: '搜索需求单' })).toHaveFocus(),
    )
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
    await waitFor(() => expectTotals(1, 1), AUDIT_REFRESH_TIMEOUT)

    const fresh = addMockConversation('刚开的片')
    fresh.ownerUserId = other.id
    fresh.activity = RUNNING
    socket.deliver(workChanged(fresh.id, { busy: true }))
    expect(await rowOf('刚开的片', AUDIT_REFRESH_TIMEOUT)).toHaveTextContent('进行中')
    await waitFor(() => expectTotals(2, 2), AUDIT_REFRESH_TIMEOUT)
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
