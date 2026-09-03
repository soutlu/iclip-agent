/**
 * 会话页：历史铺得出来，逐字来的内容跟着长。
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { mockTranscriptPage } from '@/testing/mocks/transcript'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
import { Toaster } from '@/shared/ui/toast'
import { ConversationRoute } from './conversation-route'

// lottie-web 在模块加载时会探测 canvas 2d context；jsdom 没有它。摄像机是 aria-hidden
// 装饰件，这些用例只验证状态文案与对话行为。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

const TAIL_TEXT = '这是第 2 轮的回复。'

/** 渲染会话页。连接与握手由 renderWithProviders 备好，返回的 socket 可以继续灌帧。 */
const renderConversation = async () =>
  renderWithProviders(<ConversationRoute conversationId="c1" />)

/** 一批 ops 帧，直接灌给假 socket。 */
const opsFrame = (ops: unknown[], seq: number) => ({
  payload: { agent_id: 'main', ops, seq },
  session_id: 'c1',
  type: 'transcript.ops',
})

const runningPrompt = (promptId: string) => ({
  op: 'prompt.upsert',
  prompt: { createdAt: '2026-08-31T03:00:00Z', promptId, status: 'running' },
})

/** 等人点头的那次调用：审批卡按帧上的 `approvalId` 认领它。 */
const APPROVAL_TURN = {
  kind: 'turn',
  ordinal: 3,
  origin: { kind: 'user' },
  content: [{ text: '把两张镜头帧拼成封面', type: 'text' }],
  startedAt: '2026-08-31T02:10:00Z',
  state: 'running',
  steps: [
    {
      frames: [
        {
          approvalId: 'appr_1',
          display: { kind: 'file_io', operation: 'write', path: 'shots/cover.md' },
          frameId: 'ta.1.f1',
          input: { path: 'shots/cover.md' },
          kind: 'tool',
          name: 'write_file',
          state: 'running',
          toolCallId: 'call_cover',
        },
      ],
      kind: 'step',
      ordinal: 1,
      startedAt: '2026-08-31T02:10:00Z',
      state: 'running',
      stepId: 'ta.1',
      turnId: 'ta',
    },
  ],
  turnId: 'ta',
}

/** 把基线换成「停在审批上」的那一页。要在渲染之前装。 */
const serveApprovalPage = () => {
  const page = mockTranscriptPage()
  server.use(
    http.get('*/api/conversations/c1/transcript', () =>
      HttpResponse.json({
        ...page,
        interactions: [
          {
            interactionId: 'appr_1',
            interactionKind: 'approval',
            state: 'pending',
            toolCallId: 'call_cover',
          },
        ],
        items: [...page.items, APPROVAL_TURN],
        meta: { ...page.meta, activity: 'turn' },
        pending_interactions: ['appr_1'],
        prompts: [{ createdAt: '2026-08-31T02:10:00Z', promptId: 'p-cover', status: 'running' }],
      }),
    ),
  )
}

const queuedPrompt = (promptId: string, text: string) => ({
  op: 'prompt.upsert',
  prompt: {
    content: [{ text, type: 'text' }],
    createdAt: '2026-08-31T03:00:01Z',
    promptId,
    status: 'queued',
  },
})

describe('ConversationRoute', () => {
  it('在输入框底部显示后端给出的上下文占用环', async () => {
    await renderConversation()

    expect(
      await screen.findByRole('button', { name: '3.1% · 32.8k / 1M 上下文已使用' }),
    ).toBeInTheDocument()
  })

  it('把历史那几轮铺开：用户那条、模型那条、工具卡', async () => {
    await renderConversation()

    expect(await screen.findByText('第 1 个问题')).toBeInTheDocument()
    expect(screen.getByText(TAIL_TEXT)).toBeInTheDocument()
    // 工具卡认的是服务端给的 display，不是工具名——工具名不上界面。
    expect(screen.getByText('读文件')).toBeInTheDocument()
    expect(screen.getByText('shots/storyboard.md')).toBeInTheDocument()
    expect(screen.queryByText('read_file')).not.toBeInTheDocument()
  })

  it('逐字追加接在同一块上，不另起一段', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver({
      payload: {
        agent_id: 'main',
        ops: [
          {
            offset: TAIL_TEXT.length,
            op: 'append',
            target: { frameId: 't2.1.f3', stepId: 't2.1', turnId: 't2', type: 'frame' },
            text: '再补一句。',
          },
        ],
        seq: 11,
      },
      session_id: 'c1',
      type: 'transcript.ops',
    })

    expect(await screen.findByText(`${TAIL_TEXT}再补一句。`)).toBeInTheDocument()
  })

  it('发出去先挂气泡，服务端记下它之后交给时间线', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let submitted = ''
    server.use(
      http.post('*/api/conversations/c1/prompts', async ({ request }) => {
        const body = (await request.json()) as { content: { text: string }[]; prompt_id: string }
        submitted = body.prompt_id
        return HttpResponse.json({
          createdAt: '2026-08-31T03:00:00Z',
          promptId: body.prompt_id,
          status: 'running',
        })
      }),
    )

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))

    // 服务端还没记下，本地这条先顶着；输入框已经清空
    await waitFor(() => {
      expect(screen.getAllByText('再拆一段')).toHaveLength(1)
    })
    expect(screen.getByRole('status')).toHaveTextContent('请求中…')
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('')
    expect(submitted).not.toBe('')

    // running prompt 不能提前撤掉气泡；要等 turn.prompt 真正接手。
    socket.deliver(opsFrame([runningPrompt(submitted)], 11))

    expect(await screen.findByRole('status')).toHaveTextContent('请求中…')
    expect(screen.getAllByText('再拆一段')).toHaveLength(1)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              content: [{ text: '再拆一段', type: 'text' }],
              state: 'running',
              turnId: 't3',
            },
          },
          { meta: { activity: 'turn' }, op: 'meta.merge' },
        ],
        12,
      ),
    )

    expect(await screen.findByRole('status')).toHaveTextContent('请求中…')
    expect(screen.getAllByText('再拆一段')).toHaveLength(1)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f2', kind: 'thinking', text: '先看看已经有哪些镜头。' },
            stepId: 't3.1',
            turnId: 't3',
          },
        ],
        13,
      ),
    )

    // 这一批落地了（思考块出来了），而那句话还是只有一条——认领漏了就会并排出现两次。
    // 轮子还在跑，思考标题是进行态；等轮子收尾后落定成「思考过程」，计时冻结
    expect(await screen.findByText('思考中…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('工作中…')
    expect(screen.getAllByText('再拆一段')).toHaveLength(1)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'turn.upsert',
            turn: {
              endedAt: '2026-08-31T03:00:05Z',
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              content: [{ text: '再拆一段', type: 'text' }],
              state: 'completed',
              turnId: 't3',
            },
          },
          { meta: { activity: 'idle' }, op: 'meta.merge' },
        ],
        14,
      ),
    )

    expect(await screen.findByText('思考过程')).toBeInTheDocument()
    // Kimi 的 inFlight 不会被 completed turn 抢先清掉，收尾窗口也不会反弹成「请求中」。
    expect(screen.getByRole('status')).toHaveTextContent('工作中…')

    socket.deliver(
      opsFrame(
        [
          {
            op: 'prompt.upsert',
            prompt: {
              createdAt: '2026-08-31T03:00:00Z',
              finishedAt: '2026-08-31T03:00:05Z',
              promptId: submitted,
              status: 'completed',
            },
          },
        ],
        15,
      ),
    )

    await waitFor(() => expect(screen.queryByText('工作中…')).toBeNull())
  })

  it('发送失败把字还回输入框', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    server.use(
      http.post('*/api/conversations/c1/prompts', () =>
        HttpResponse.json({ detail: '这段对话不是你的' }, { status: 403 }),
      ),
    )

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))

    const editor = await screen.findByLabelText('输入消息')
    await waitFor(() => expect(editor).toHaveTextContent('再拆一段'))
    // 气泡撤掉了：那句话只剩输入框里这一份
    expect(screen.queryAllByText('再拆一段')).toHaveLength(1)
  })

  it('在跑的时候发送钮换成停止钮，点它停掉在跑的那条', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let aborted = ''
    server.use(
      http.post('*/api/conversations/c1/prompts/:promptId', ({ params }) => {
        aborted = String(params['promptId'])
        return new HttpResponse(null, { status: 204 })
      }),
    )

    socket.deliver(opsFrame([runningPrompt('p-run')], 11))

    const stop = await screen.findByRole('button', { name: '停止' })
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()

    await user.click(stop)

    await waitFor(() => {
      expect(aborted).toBe('p-run:abort')
    })
  })

  it('排队那条由服务端那份渲染，点「立即发送」把它插进当前这一轮', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let steered: string[] = []
    server.use(
      http.post('*/api/conversations/c1/prompts:steer', async ({ request }) => {
        const body = (await request.json()) as { prompt_ids: string[] }
        steered = body.prompt_ids
        return new HttpResponse(null, { status: 204 })
      }),
    )

    socket.deliver(opsFrame([runningPrompt('p-run'), queuedPrompt('p-queued', '顺便配个音')], 11))

    expect(await screen.findByText('顺便配个音')).toBeInTheDocument()
    expect(screen.getByText('1 个任务等待发送')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '立即发送到当前回合' }))

    await waitFor(() => {
      expect(steered).toEqual(['p-queued'])
    })
  })

  it('只有最后一轮带「重新生成」钮', async () => {
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    expect(
      within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '重新生成' }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByLabelText('第 1 轮')).queryByRole('button', { name: '重新生成' }),
    ).toBeNull()
  })

  it('点「重新生成」打 :regenerate 端点，新一轮走推送回流', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    let regenerated = ''
    server.use(
      http.post('*/api/conversations/c1/turns/*', ({ request }) => {
        regenerated = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
        return HttpResponse.json({
          createdAt: '2026-08-31T03:02:00Z',
          promptId: 'prm_regen_1',
          status: 'running',
        })
      }),
    )

    await user.click(
      within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '重新生成' }),
    )

    await waitFor(() => {
      expect(regenerated).toBe('t2:regenerate')
    })
  })

  it('对话在忙时「重新生成」置灰', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    const button = within(screen.getByLabelText('第 2 轮')).getByRole('button', {
      name: '重新生成',
    })
    expect(button).toBeEnabled()

    socket.deliver(opsFrame([runningPrompt('p-run')], 11))

    await waitFor(() => expect(button).toBeDisabled())
  })

  it('重新生成被服务端拒了（409）时把它给的中文文案弹出来', async () => {
    const user = userEvent.setup()
    await renderWithProviders(
      <>
        <ConversationRoute conversationId="c1" />
        <Toaster />
      </>,
    )
    await screen.findByText(TAIL_TEXT)

    server.use(
      http.post('*/api/conversations/c1/turns/*', () =>
        HttpResponse.json({ detail: '这段对话还在忙，等它收完尾再重新生成' }, { status: 409 }),
      ),
    )

    await user.click(
      within(screen.getByLabelText('第 2 轮')).getByRole('button', { name: '重新生成' }),
    )

    expect(
      await screen.findByText('重新生成失败：这段对话还在忙，等它收完尾再重新生成'),
    ).toBeInTheDocument()
  })

  it('工具结果是纯文本时可以展开，没有结果就不给展开箭头', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    // 历史那次读文件没带结果：整行不可点，不该出现能点开又什么都没有的箭头
    expect(screen.queryByRole('button', { name: /读文件/ })).toBeNull()

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: {
              display: { kind: 'file_io', operation: 'grep', path: 'shots/' },
              frameId: 't2.1.f4',
              kind: 'tool',
              name: 'search_files',
              output: 'shots/s01.md\nshots/s02.md',
              state: 'done',
              toolCallId: 'call_grep',
            },
            stepId: 't2.1',
            turnId: 't2',
          },
        ],
        11,
      ),
    )

    const row = await screen.findByRole('button', { name: /搜内容/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')

    await user.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/shots\/s01\.md/)).toBeInTheDocument()
  })

  it('助手正文按 markdown 渲染：列表、粗体、行内代码', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: {
              frameId: 't2.1.f8',
              kind: 'text',
              role: 'assistant',
              text: '要点：\n\n- 拆出 **3 个**镜头\n- 写进 `shots/s09.md`\n',
            },
            stepId: 't2.1',
            turnId: 't2',
          },
        ],
        11,
      ),
    )

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(screen.getByText('3 个').tagName).toBe('STRONG')
    expect(screen.getByText('shots/s09.md').tagName).toBe('CODE')
  })

  it('正文里夹的 HTML 会渲染，脚本与事件属性被摘掉', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'frame.upsert',
            frame: {
              frameId: 't2.1.f7',
              kind: 'text',
              role: 'assistant',
              text: [
                '<details><summary>展开看设定</summary>',
                '<p id="html-body">这段是 <b>HTML</b></p></details>',
                '<script>window.__pwned = true</script>',
                '<p onclick="window.__pwned = true" id="html-click">点我</p>',
              ].join('\n'),
            },
            stepId: 't2.1',
            turnId: 't2',
          },
        ],
        11,
      ),
    )

    expect(await screen.findByText('展开看设定')).toBeInTheDocument()
    expect(screen.getByText('HTML').tagName).toBe('B')
    // 脚本整段不见，事件属性被摘掉：正文是模型写的，这两样放行就是一条 XSS 通道
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText('点我')).not.toHaveAttribute('onclick')
  })

  it('连续的思考与工具收成一行活动组，点开铺开每一条', async () => {
    const user = userEvent.setup()
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver(
      opsFrame(
        [
          {
            op: 'turn.upsert',
            turn: {
              endedAt: '2026-08-31T03:01:00Z',
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              content: [{ text: '拆', type: 'text' }],
              startedAt: '2026-08-31T03:00:00Z',
              state: 'completed',
              turnId: 't3',
            },
          },
          {
            op: 'step.upsert',
            step: {
              endedAt: '2026-08-31T03:01:00Z',
              kind: 'step',
              ordinal: 1,
              startedAt: '2026-08-31T03:00:00Z',
              state: 'completed',
              stepId: 't3.1',
              turnId: 't3',
            },
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f2', kind: 'thinking', text: '想' },
            stepId: 't3.1',
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: {
              display: { kind: 'file_io', operation: 'read', path: 'shots/storyboard.md' },
              frameId: 't3.1.f3',
              kind: 'tool',
              name: 'read_file',
              state: 'done',
              toolCallId: 'c3a',
            },
            stepId: 't3.1',
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: {
              display: { kind: 'file_io', operation: 'write', path: 'shots/storyboard.md' },
              frameId: 't3.1.f4',
              kind: 'tool',
              name: 'write_file',
              state: 'done',
              toolCallId: 'c3b',
            },
            stepId: 't3.1',
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f5', kind: 'text', role: 'assistant', text: '拆好了。' },
            stepId: 't3.1',
            turnId: 't3',
          },
        ],
        11,
      ),
    )

    // 一叠聚成一行：读取 + 写入 + 步骤起止算出的时长；轮子已收尾所以是收起的
    const head = await screen.findByRole('button', {
      name: /完成：读取了 1 个文件 · 写入了 1 个文件/,
    })
    expect(head).toHaveAttribute('aria-expanded', 'false')

    await user.click(head)

    // 铺开之后每条就是普通的工具行
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('shots/storyboard.md').length).toBeGreaterThan(1)
  })

  it('历史消息里的附件画成芯片，点开进灯箱', async () => {
    const user = userEvent.setup()
    await renderConversation()
    await screen.findByText(TAIL_TEXT)

    // mock 里那张图是 data URL，没有文件名，芯片就叫「图片」
    await user.click(await screen.findByRole('button', { name: '图片' }))

    const dialog = await screen.findByRole('dialog', { name: '图片' })
    expect(within(dialog).getByRole('img', { name: '图片' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('等审批时贴出审批卡，点「同意」打 interactions 端点', async () => {
    const user = userEvent.setup()
    serveApprovalPage()
    let decided: { body: unknown; path: string } | null = null
    server.use(
      http.post('*/api/conversations/c1/interactions/:interactionId', async ({ request }) => {
        decided = { body: await request.json(), path: new URL(request.url).pathname }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await renderConversation()

    // 卡面复用工具卡那份 display：这一步要写哪个文件写在标题旁边
    const card = await screen.findByRole('region', { name: '等你审批' })
    expect(within(card).getByText('写文件')).toBeInTheDocument()
    expect(within(card).getByText('shots/cover.md')).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: /同意/ }))

    await waitFor(() => {
      expect(decided).toEqual({
        body: { approved: true },
        path: '/api/conversations/c1/interactions/appr_1',
      })
    })
    // 撤掉这张卡的是服务端那份 pending 集合，本地只把两个钮换成结果
    expect(await within(card).findByText('已同意')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /拒绝/ })).toBeNull()
  })

  it('点「拒绝」发的是 approved: false', async () => {
    const user = userEvent.setup()
    serveApprovalPage()
    let body: unknown = null
    server.use(
      http.post('*/api/conversations/c1/interactions/:interactionId', async ({ request }) => {
        body = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await renderConversation()

    const card = await screen.findByRole('region', { name: '等你审批' })
    await user.click(within(card).getByRole('button', { name: /拒绝/ }))

    await waitFor(() => expect(body).toEqual({ approved: false }))
    expect(await within(card).findByText('已拒绝')).toBeInTheDocument()
  })

  it('改主意（409）时说清已经做过决定', async () => {
    const user = userEvent.setup()
    serveApprovalPage()
    server.use(
      http.post('*/api/conversations/c1/interactions/:interactionId', () =>
        HttpResponse.json({ detail: '这张卡已经做过决定了' }, { status: 409 }),
      ),
    )
    await renderWithProviders(
      <>
        <ConversationRoute conversationId="c1" />
        <Toaster />
      </>,
    )

    const card = await screen.findByRole('region', { name: '等你审批' })
    await user.click(within(card).getByRole('button', { name: /同意/ }))

    expect(await screen.findByText('已经做过决定')).toBeInTheDocument()
    // 决定没记下，两个钮还在
    expect(within(card).getByRole('button', { name: /拒绝/ })).toBeInTheDocument()
  })

  it('等审批时不给追加入口，输入框改口说在等谁', async () => {
    serveApprovalPage()
    const { socket } = await renderConversation()
    await screen.findByRole('region', { name: '等你审批' })

    socket.deliver(opsFrame([queuedPrompt('p-queued', '顺便配个音')], 11))

    expect(await screen.findByText('1 个任务等待发送')).toBeInTheDocument()
    // 等人点头的时候没有在跑的那一轮可插：追加得等决定落下去
    expect(screen.queryByRole('button', { name: '立即发送到当前回合' })).toBeNull()
    expect(screen.getByText('等你审批后继续')).toBeInTheDocument()
  })

  it('标题来自基线，服务端起了新名字就当场换掉', async () => {
    const { socket } = await renderConversation()

    // 首屏那个名字只有基线给得出：侧栏拓扑只有每段列表的第一页，翻不到更早的对话。
    expect(await screen.findByRole('heading', { name: '夜景延时素材生成' })).toBeVisible()

    socket.deliver({
      type: 'session.meta.updated',
      payload: { session_id: 'c1', title: '改过的名字' },
    })

    expect(await screen.findByRole('heading', { name: '改过的名字' })).toBeVisible()
  })
})
