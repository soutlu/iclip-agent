import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { TasksRoute } from '@/features/tasks'
import { addMockTask, mockAuthUser, mockConversations } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { useStartTaskCreation } from './-use-start-task-creation'

function TaskCreationPage() {
  const startCreation = useStartTaskCreation()
  return <TasksRoute onStartCreation={startCreation} />
}

const prepare = async () => {
  await fetch('/api/auth/login', {
    body: new URLSearchParams({ username: 'tester', password: 'x' }),
    method: 'POST',
  })
  const task = addMockTask('短靴创作需求')
  task.status = 'confirmed'
  task.assigneeUserIds = [mockAuthUser.id]
  task.deadline = '2099-01-01T12:00:00Z'
  task.inputs = {
    ...task.inputs,
    creative_requirement: '保留这段原文。\n第二行要求。',
    product: { ...task.inputs.product, image_oss_urls: ['https://example.com/boot.jpg'] },
    video_spec: { ...task.inputs.video_spec, aspect_ratio: '9:16', duration_seconds: 25 },
  }
  const user = userEvent.setup()
  const rendered = await renderWithProviders(<TaskCreationPage />)
  const mine = await screen.findByRole('region', { name: '我的需求单' })
  await user.click(await within(mine).findByRole('button', { name: /短靴创作需求/ }))
  await user.click(await screen.findByRole('button', { name: '开始创作' }))
  return { ...rendered, user, task }
}

describe('需求单发起对话', () => {
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
})
