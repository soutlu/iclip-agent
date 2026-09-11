import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { pasteTextIntoComposer } from '@/testing/editor'
import { mockAuthUser, mockCollections, mockConversations } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { HomePage } from './-home-page'
import { LoginPromptProvider } from './-login-prompt'

// jsdom 无 canvas；只替换装饰动画依赖。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

const renderHome = async () => {
  const rendered = await renderWithProviders(
    <LoginPromptProvider value={() => undefined}>
      <HomePage />
    </LoginPromptProvider>,
  )
  return { ...rendered, user: userEvent.setup() }
}

const authenticate = () =>
  server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))

const promptReceipt = (promptId: string) =>
  HttpResponse.json({ createdAt: new Date().toISOString(), promptId, status: 'queued' })

describe('首页真实数据流程', () => {
  it('新建合集后立即选中；选择服务端 Agent 并将合集带入首条创作', async () => {
    authenticate()
    server.use(
      http.get('*/api/conversations/agents', () =>
        HttpResponse.json({ items: ['new-agent'], default: 'new-agent' }),
      ),
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByRole('button', { name: 'new-agent' })
    await user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    await user.type(screen.getByRole('combobox', { name: '搜索合集' }), '秋季短片')
    await user.click(screen.getByRole('button', { name: '新建“秋季短片”' }))
    expect(screen.getByRole('textbox', { name: '合集名称' })).toHaveValue('秋季短片')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '关联合集：秋季短片' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '制作秋季宣传片')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(mockCollections).toHaveLength(1)
    expect(mockConversations).toHaveLength(1)
    expect(mockConversations[0]).toMatchObject({
      agentId: 'new-agent',
      collectionId: mockCollections[0]?.id,
    })
  })

  it('首条消息回执失败时保留输入；重试复用同一对话与消息编号', async () => {
    authenticate()
    const bodies: { prompt_id: string; content: unknown[] }[] = []
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        const body = (await request.json()) as (typeof bodies)[number]
        bodies.push(body)
        return bodies.length === 1
          ? HttpResponse.json({ detail: '发送回执中断' }, { status: 503 })
          : promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '保留我的原稿')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(router.state.location.pathname).toBe('/')
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('保留我的原稿')
    expect(mockConversations).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/c/${mockConversations[0]?.id}`),
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(mockConversations).toHaveLength(1)
  })

  it('创建回执失败后用同一对话编号重试，创建成功前不发消息', async () => {
    authenticate()
    const ids: string[] = []
    let sends = 0
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/conversations') {
        const body = (await request.clone().json()) as { id: string }
        ids.push(body.id)
      }
    })
    server.use(
      http.post(
        '*/api/conversations',
        () => HttpResponse.json({ detail: '创建回执中断' }, { status: 503 }),
        { once: true },
      ),
      http.post('*/api/conversations/:conversationId/prompts', async ({ request }) => {
        sends += 1
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '创建后发送')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(ids).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(sends).toBe(0)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(mockConversations[0]?.id).toBe(ids[0])
    expect(sends).toBe(1)
  })

  it('Agent 目录读取失败可重试，空目录不会创建对话', async () => {
    authenticate()
    server.use(
      http.get(
        '*/api/conversations/agents',
        () => HttpResponse.json({ detail: '目录读取失败' }, { status: 503 }),
        { once: true },
      ),
      http.get('*/api/conversations/agents', () => HttpResponse.json({ items: [], default: null })),
    )
    const { user } = await renderHome()
    await user.click(await screen.findByRole('button', { name: 'Agent 加载失败' }))
    await user.click(screen.getByRole('menuitem', { name: '重新加载 Agent' }))
    await screen.findByRole('button', { name: '暂无可用 Agent' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '暂存内容')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(mockConversations).toHaveLength(0)
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('暂存内容')
  })

  it('失败后对话被删除，明确收到 404 后的下一次主动提交使用新编号', async () => {
    authenticate()
    const targets: string[] = []
    server.use(
      http.post('*/api/conversations/:conversationId/prompts', async ({ params, request }) => {
        const target = String(params['conversationId'])
        targets.push(target)
        if (!mockConversations.some((item) => item.id === target)) {
          return HttpResponse.json({ detail: '对话已不存在' }, { status: 404 })
        }
        if (targets.length === 1)
          return HttpResponse.json({ detail: '暂时无法发送' }, { status: 503 })
        const body = (await request.json()) as { prompt_id: string }
        return promptReceipt(body.prompt_id)
      }),
    )
    const { user, router } = await renderHome()
    await screen.findByRole('button', { name: '分镜 Agent' })
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '保留这份原稿')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(targets).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    const removed = mockConversations[0]
    if (!removed) throw new Error('首次提交没有创建对话')
    await fetch(`/api/conversations/${removed.id}`, { method: 'DELETE' })
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(targets).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(router.state.location.pathname).toBe('/')
    expect(mockConversations).toHaveLength(0)
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('保留这份原稿')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/c\//))
    expect(targets[1]).toBe(removed.id)
    expect(targets[2]).not.toBe(removed.id)
    expect(mockConversations).toHaveLength(1)
  })
})
