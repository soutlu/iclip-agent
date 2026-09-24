import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { TasksRoute } from '@/features/tasks'
import {
  addMockConversation,
  addMockTask,
  liveMockConversation,
  loginAs,
  mockAuthUser,
  mockConversations,
} from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { useStartTaskCreation } from './-use-start-task-creation'

function TaskCreationPage() {
  const creation = useStartTaskCreation()
  return <TasksRoute creation={creation} />
}

const liveConversations = () => mockConversations.filter((item) => item.deletedAt === null)

/** 打开一张可开始的需求单的预览；给了 agentName 就在预览里选上它。 */
const prepare = async (agentName: string | null = '分镜 Agent') => {
  loginAs(mockAuthUser)
  const task = addMockTask('短靴创作需求')
  task.status = 'confirmed'
  task.assigneeUserIds = [mockAuthUser.id]
  task.deadline = '2099-01-01T12:00:00Z'
  task.inputs = {
    ...task.inputs,
    creative_requirement: '保留这段原文。\n第二行要求。',
    products: task.inputs.products.map((product) => ({
      ...product,
      image_oss_urls: ['https://example.com/boot.jpg'],
    })),
    video_spec: { ...task.inputs.video_spec, aspect_ratio: '9:16', duration_seconds: 25 },
  }
  const user = userEvent.setup()
  const rendered = await renderWithProviders(<TaskCreationPage />)
  const mine = await screen.findByRole('region', { name: '我的需求单' })
  await user.click(await within(mine).findByRole('button', { name: /短靴创作需求/ }))
  await user.click(await screen.findByRole('button', { name: '开始创作' }))
  const preview = await screen.findByRole('dialog', { name: '发起创作' })
  if (agentName !== null) {
    await user.click(await within(preview).findByRole('button', { name: '请选择 Agent' }))
    await user.click(await screen.findByRole('menuitem', { name: agentName }))
  }
  return { ...rendered, user, task, preview }
}

const promptReceipt = async (request: Request) => {
  const body = (await request.json()) as { prompt_id: string }
  return HttpResponse.json({
    createdAt: new Date().toISOString(),
    promptId: body.prompt_id,
    status: 'queued',
  })
}

describe('需求单发起对话', () => {
  it('预览不预选 Agent，选定名册里的哪一项就用哪一项建对话', async () => {
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', ({ request }) =>
        promptReceipt(request),
      ),
    )
    const { user, router, task, preview } = await prepare(null)
    const confirm = within(preview).getByRole('button', { name: '确认并开始' })
    expect(within(preview).getByRole('button', { name: '请选择 Agent' })).toBeVisible()
    expect(confirm).toBeDisabled()

    await user.click(within(preview).getByRole('button', { name: '请选择 Agent' }))
    await user.click(await screen.findByRole('menuitem', { name: '完全复刻' }))
    expect(within(preview).getByRole('button', { name: '完全复刻' })).toBeVisible()
    await user.click(confirm)
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(mockConversations).toHaveLength(1)
    expect(mockConversations[0]).toMatchObject({ agentId: 'replica', taskId: task.id })
  })

  it('名册读取失败显示原因并可重新加载，空名册不能开始', async () => {
    server.use(
      http.get(
        '*/api/conversations/agents',
        () => HttpResponse.json({ detail: '目录读取失败' }, { status: 503 }),
        { once: true },
      ),
      http.get('*/api/conversations/agents', () => HttpResponse.json({ items: [], default: null })),
    )
    const { user, preview } = await prepare(null)
    const confirm = within(preview).getByRole('button', { name: '确认并开始' })
    await user.click(await within(preview).findByRole('button', { name: 'Agent 加载失败' }))
    const failedMenu = await screen.findByRole('menu')
    expect(within(failedMenu).getByRole('alert')).toHaveTextContent('目录读取失败')
    expect(confirm).toBeDisabled()

    await user.click(within(failedMenu).getByRole('menuitem', { name: '重新加载 Agent' }))
    await user.click(await within(preview).findByRole('button', { name: '暂无可用 Agent' }))
    expect(within(await screen.findByRole('menu')).getByRole('status')).toHaveTextContent(
      '暂无可用 Agent',
    )
    expect(confirm).toBeDisabled()
    expect(mockConversations).toHaveLength(0)
  })

  it('首次消息失败后重试复用已关联的对话、消息编号和原始内容', async () => {
    const bodies: { prompt_id: string; content: unknown[] }[] = []
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as (typeof bodies)[number]
        bodies.push(body)
        if (bodies.length === 1)
          return HttpResponse.json({ detail: '暂时无法发送' }, { status: 503 })
        return HttpResponse.json({
          createdAt: new Date().toISOString(),
          promptId: body.prompt_id,
          status: 'queued',
        })
      }),
    )
    const { user, task, router } = await prepare()
    await user.click(screen.getByRole('button', { name: '确认并开始' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法发送')
    expect(mockConversations).toHaveLength(1)
    const conversation = mockConversations[0]
    if (!conversation) throw new Error('未创建对话')
    expect(conversation).toMatchObject({
      taskId: task.id,
      agentId: 'storyboard',
      title: task.title,
    })

    // 外部需求更新不会悄悄改变已经确认、正在重试的这条消息。
    task.inputs = { ...task.inputs, creative_requirement: '后来改动的要求' }
    await user.click(screen.getByRole('button', { name: /确认并开始|重试发送/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${conversation.id}`))
    expect(mockConversations).toHaveLength(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(JSON.stringify(bodies[1])).not.toContain('后来改动的要求')
  })

  it('创建对话失败时不发送消息，用户重试后正常创建并发送', async () => {
    let creates = 0
    let sends = 0
    server.use(
      http.post(
        '*/api/conversations',
        () => {
          creates += 1
          return HttpResponse.json({ detail: '对话暂时无法创建' }, { status: 503 })
        },
        { once: true },
      ),
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        sends += 1
        const body = (await request.json()) as { prompt_id: string }
        return HttpResponse.json({
          createdAt: new Date().toISOString(),
          promptId: body.prompt_id,
          status: 'queued',
        })
      }),
    )
    const { user, router } = await prepare()
    await user.click(screen.getByRole('button', { name: '确认并开始' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('对话暂时无法创建')
    expect(creates).toBe(1)
    expect(sends).toBe(0)
    expect(mockConversations).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: /确认并开始|重试发送/ }))
    await waitFor(() => expect(mockConversations).toHaveLength(1))
    const conversation = mockConversations[0]
    if (!conversation) throw new Error('未创建对话')
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${conversation.id}`))
    expect(sends).toBe(1)
  })

  it('建对话已落库但回执丢了：重试沿用同一个客户端 id，不多建一段', async () => {
    const ids: string[] = []
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/conversations') {
        const body = (await request.clone().json()) as { id: string }
        ids.push(body.id)
      }
    })
    server.use(
      http.post(
        '*/api/conversations',
        async ({ request }) => {
          const body = (await request.json()) as { id: string; taskId: string; title: string }
          // 服务端已经落库，回执在路上丢了。
          Object.assign(addMockConversation(body.title), { id: body.id, taskId: body.taskId })
          return HttpResponse.error()
        },
        { once: true },
      ),
      http.post('*/api/conversations/:conversationId/prompts', ({ request }) =>
        promptReceipt(request),
      ),
    )
    const { user, router, task } = await prepare()
    await user.click(screen.getByRole('button', { name: '确认并开始' }))
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(mockConversations).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /确认并开始|重试发送/ }))
    await waitFor(() => expect(ids).toHaveLength(2))
    expect(ids[1]).toBe(ids[0])
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${ids[0]}`))
    expect(mockConversations).toHaveLength(1)
    expect(mockConversations[0]).toMatchObject({ id: ids[0], taskId: task.id })
  })

  it('对话在两次重试之间被删：明确收到 404 后，下一次重试另起一段', async () => {
    const targets: string[] = []
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', ({ params, request }) => {
        const target = String(params['conversationId'])
        targets.push(target)
        if (!liveMockConversation(target)) {
          return HttpResponse.json({ detail: '对话已不存在' }, { status: 404 })
        }
        if (targets.length === 1) {
          return HttpResponse.json({ detail: '暂时无法发送' }, { status: 503 })
        }
        return promptReceipt(request)
      }),
    )
    const { user, router, task } = await prepare()
    await user.click(screen.getByRole('button', { name: '确认并开始' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法发送')
    const removed = mockConversations[0]
    if (!removed) throw new Error('首次提交没有创建对话')
    await fetch(`/api/conversations/${removed.id}`, { method: 'DELETE' })

    await user.click(screen.getByRole('button', { name: /确认并开始|重试发送/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('对话已不存在'))
    // 删除留下墓碑（合同 §6），只数活着的对话。
    expect(liveConversations()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /确认并开始|重试发送/ }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(targets).toHaveLength(3)
    expect(targets[1]).toBe(removed.id)
    expect(targets[2]).not.toBe(removed.id)
    expect(liveConversations()).toHaveLength(1)
    expect(liveConversations()[0]).toMatchObject({ id: targets[2], taskId: task.id })
  })
})
