import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
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

describe('AuditRoute', () => {
  it('列全平台的对话：按最近活动倒序，每行有状态、属主、需求单，头上写两个总数', async () => {
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
    expect(theirs).toHaveTextContent('小王')
    expect(theirs).toHaveTextContent('秋季新品')
    expect(await rowOf('我的片')).toHaveTextContent('未运行')
    expect(await rowOf('我的片')).toHaveTextContent('测试用户')
    expect(await rowOf('跑完的片')).toHaveTextContent('已完成')
    expect(screen.getByRole('status')).toHaveTextContent('1 段在跑 · 共 3 段')
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
    expect(screen.getByRole('status')).toHaveTextContent('1 段在跑 · 共 1 段')
  })

  it('属主菜单里选人，列表只剩那个人的，片子上写着选了谁', async () => {
    seedThree()
    const { user } = await render()
    await rowOf('我的片')

    await user.click(screen.getByRole('button', { name: '属主：全部属主' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '小王' }))

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /我的片/ })).not.toBeInTheDocument(),
    )
    expect(await rowOf('小王的秋季片')).toBeVisible()
    expect(screen.getByRole('button', { name: '属主：小王' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('1 段在跑 · 共 2 段')
  })

  it('别人对话的活动帧当场改状态列并重拉总数；没见过的 id 重拉后多出一行', async () => {
    const other = addMockUser('小王')
    const theirs = addMockConversation('小王的秋季片')
    theirs.ownerUserId = other.id
    const { socket } = await render()
    expect(await rowOf('小王的秋季片')).toHaveTextContent('未运行')
    expect(screen.getByRole('status')).toHaveTextContent('0 段在跑 · 共 1 段')

    // 先改 MSW 里的事实，推送后的重拉才与就地补丁一致。
    theirs.activity = RUNNING
    socket.deliver(workChanged(theirs.id, { busy: true }))
    expect(await rowOf('小王的秋季片')).toHaveTextContent('进行中')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 段在跑 · 共 1 段'))

    const fresh = addMockConversation('刚开的片')
    fresh.ownerUserId = other.id
    fresh.activity = RUNNING
    socket.deliver(workChanged(fresh.id, { busy: true }))
    expect(await rowOf('刚开的片')).toHaveTextContent('进行中')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 段在跑 · 共 2 段'))
  })

  it('一页五十段，点「展开显示更多对话」接下一页，已显示计数跟着走', async () => {
    for (let index = 0; index < 55; index += 1) {
      addMockConversation(`第${index}段`, new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString())
    }
    const { user } = await render()

    expect(await screen.findByText('已显示 50 / 55')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '展开显示更多对话' }))

    expect(await screen.findByText('已显示 55 / 55')).toBeVisible()
    expect(screen.queryByRole('button', { name: '展开显示更多对话' })).not.toBeInTheDocument()
  })
})
