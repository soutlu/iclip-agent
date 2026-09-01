/**
 * 会话页：历史铺得出来，逐字来的内容跟着长。
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
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
              prompt: '再拆一段',
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
              prompt: '拆',
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

    await user.click(await screen.findByRole('button', { name: /参考图\.svg/ }))

    const dialog = await screen.findByRole('dialog', { name: '参考图.svg' })
    expect(within(dialog).getByRole('img', { name: '参考图.svg' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
