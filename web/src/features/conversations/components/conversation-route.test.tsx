/**
 * 会话页：历史铺得出来，逐字来的内容跟着长。
 */

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { renderWithProviders } from '@/testing/render'
import { ConversationRoute } from './conversation-route'

const TAIL_TEXT = '这是第 2 轮的回复。'

class FakeSocket {
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  send(): void {}

  close(): void {
    this.readyState = 3
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const HELLO = {
  payload: { heartbeat_ms: 10_000, protocol_version: 2, ws_connection_id: 'w1' },
  type: 'server_hello',
}

/** 渲染会话页，连接用假 socket；返回那个 socket 以便往里灌帧。 */
const renderConversation = async () => {
  const socket = new FakeSocket()
  const view = await renderWithProviders(
    <TranscriptProvider createSocket={() => socket as unknown as WebSocket}>
      <ConversationRoute conversationId="c1" />
    </TranscriptProvider>,
  )
  socket.deliver(HELLO)
  return { ...view, socket }
}

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

    await user.type(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))

    // 服务端还没记下，本地这条先顶着；输入框已经清空
    await waitFor(() => {
      expect(screen.getAllByText('再拆一段')).toHaveLength(1)
    })
    expect(screen.getByLabelText('输入消息')).toHaveValue('')
    expect(submitted).not.toBe('')

    // 服务端带着同一个 promptId 回来：本地那条撤掉，时间线上那一条接手
    socket.deliver({
      payload: {
        agent_id: 'main',
        ops: [
          {
            op: 'prompt.upsert',
            prompt: { createdAt: '2026-08-31T03:00:00Z', promptId: submitted, status: 'running' },
          },
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              prompt: '再拆一段',
              state: 'running',
              turnId: 't3',
            },
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f1', kind: 'text', role: 'user', text: '再拆一段' },
            stepId: 't3.1',
            turnId: 't3',
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't3.1.f2', kind: 'thinking', text: '先看看已经有哪些镜头。' },
            stepId: 't3.1',
            turnId: 't3',
          },
        ],
        seq: 11,
      },
      session_id: 'c1',
      type: 'transcript.ops',
    })

    // 这一批落地了（思考块出来了），而那句话还是只有一条——认领漏了就会并排出现两次。
    // 轮子还在跑，思考标题是进行态；等轮子收尾后落定成「思考过程」，计时冻结
    expect(await screen.findByText('思考中…')).toBeInTheDocument()
    expect(screen.getAllByText('再拆一段')).toHaveLength(1)

    socket.deliver({
      payload: {
        agent_id: 'main',
        ops: [
          {
            op: 'turn.upsert',
            turn: {
              endedAt: '2026-08-31T03:00:05Z',
              kind: 'turn',
              ordinal: 3,
              origin: { kind: 'user' },
              state: 'completed',
              turnId: 't3',
            },
          },
        ],
        seq: 12,
      },
      session_id: 'c1',
      type: 'transcript.ops',
    })

    expect(await screen.findByText('思考过程')).toBeInTheDocument()
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

    await user.type(screen.getByLabelText('输入消息'), '再拆一段')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByLabelText('输入消息')).toHaveValue('再拆一段')
    // 气泡撤掉了：留下的只有输入框里那份文字
    expect(
      screen.queryAllByText('再拆一段').filter((node) => node.tagName !== 'TEXTAREA'),
    ).toHaveLength(0)
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
})
