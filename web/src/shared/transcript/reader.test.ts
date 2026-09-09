import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { mockTranscriptPage } from '@/testing/mocks/transcript'
import { TranscriptConnection } from './connection'
import { TranscriptReader } from './reader'

const TAIL_TEXT = '这是第 2 轮的回复。'
const TAIL_FRAME = { frameId: 't2.1.f3', stepId: 't2.1', turnId: 't2', type: 'frame' } as const

class FakeSocket {
  readyState = 1
  sent: string[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

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

const EMPTY_SNAPSHOT = {
  attachments: [],
  interactions: [],
  items: [],
  meta: {},
  prompts: [],
  tasks: [],
  todos: [],
}

const append = (offset: number, text: string) => [
  { offset, op: 'append', target: TAIL_FRAME, text },
]

const opsFrame = (seq: number, ops: unknown[]) => ({
  payload: { agent_id: 'main', ops, seq },
  session_id: 'c1',
  type: 'transcript.ops',
})

const resetFrame = (seq: number) => ({
  payload: { agent_id: 'main', has_more_older: true, seq, snapshot: EMPTY_SNAPSHOT },
  session_id: 'c1',
  type: 'transcript.reset',
})

const startReader = () => {
  const socket = new FakeSocket()
  const connection = new TranscriptConnection({
    createSocket: () => socket as unknown as WebSocket,
    url: 'ws://test/api/ws',
  })
  connection.connect()
  const reader = new TranscriptReader('c1', connection)
  reader.start()
  socket.deliver(HELLO)
  return { connection, reader, socket }
}

const textOf = (reader: TranscriptReader): string =>
  reader
    .view()
    .items.flatMap((item) => (item.kind === 'turn' ? item.steps : []))
    .flatMap((step) => step.frames)
    .map((frame) => ('text' in frame ? frame.text : ''))
    .join('|')

describe('TranscriptReader', () => {
  it('基线与 meta.merge 都把后端的上下文 used/max 原样交给界面', async () => {
    const { reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().contextTokens).toBe(32768)
      expect(reader.view().maxContextTokens).toBe(1048576)
    })

    socket.deliver(
      opsFrame(11, [
        {
          meta: {
            agent: { contextTokens: 65536, contextUsage: 0.0625, maxContextTokens: 1048576 },
          },
          op: 'meta.merge',
        },
      ]),
    )

    await vi.waitFor(() => {
      expect(reader.view().contextTokens).toBe(65536)
      expect(reader.view().maxContextTokens).toBe(1048576)
    })
  })

  it('基线还没到就先攒着，落地之后按批次号叠上', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('*/api/conversations/c1/transcript', async () => {
        await gate
        return HttpResponse.json(mockTranscriptPage())
      }),
    )

    const { reader, socket } = startReader()
    // 基线加载中缓冲批次，避免被晚到基线覆盖。
    socket.deliver(opsFrame(11, append(TAIL_TEXT.length, '补一句')))
    release()

    await vi.waitFor(() => {
      expect(textOf(reader)).toContain(`${TAIL_TEXT}补一句`)
    })
  })

  it('批次号跳了就不落地，去补缺的那几批', async () => {
    server.use(
      http.get('*/api/conversations/c1/transcript', () => HttpResponse.json(mockTranscriptPage())),
      http.get('*/api/conversations/c1/transcript/ops', ({ request }) => {
        const since = new URL(request.url).searchParams.get('since_seq')
        expect(since).toBe('10')
        return HttpResponse.json({
          agent_id: 'main',
          batches: [
            { ops: append(TAIL_TEXT.length, '甲'), seq: 11 },
            { ops: append(TAIL_TEXT.length + 1, '乙'), seq: 12 },
          ],
          complete: true,
          latest_seq: 12,
        })
      }),
    )

    const { connection, reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })

    socket.deliver(opsFrame(12, append(TAIL_TEXT.length + 1, '乙')))
    expect(connection.watermarkOf('c1', 'main')).toBe(10)

    await vi.waitFor(() => {
      expect(textOf(reader)).toContain(`${TAIL_TEXT}甲乙`)
    })
  })

  it('补回来的批次里带着块，一样落得下去', async () => {
    server.use(
      http.get('*/api/conversations/c1/transcript', () => HttpResponse.json(mockTranscriptPage())),
      http.get('*/api/conversations/c1/transcript/ops', () =>
        HttpResponse.json({
          agent_id: 'main',
          batches: [
            {
              ops: [
                {
                  frame: {
                    frameId: 't2.1.f9',
                    kind: 'text',
                    role: 'assistant',
                    text: '补回来的一段',
                  },
                  op: 'frame.upsert',
                  stepId: 't2.1',
                  turnId: 't2',
                },
              ],
              seq: 11,
            },
          ],
          complete: true,
          latest_seq: 11,
        }),
      ),
    )

    const { reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })

    socket.deliver(opsFrame(12, append(TAIL_TEXT.length, '甲')))

    await vi.waitFor(() => {
      expect(textOf(reader)).toContain('补回来的一段')
    })
  })

  it('服务端说批次要不回来了，就整页重拉', async () => {
    let pages = 0
    server.use(
      http.get('*/api/conversations/c1/transcript', () => {
        pages += 1
        return HttpResponse.json(mockTranscriptPage())
      }),
      http.get('*/api/conversations/c1/transcript/ops', () =>
        HttpResponse.json({ agent_id: 'main', batches: [], complete: false, latest_seq: 20 }),
      ),
    )

    const { reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })

    socket.deliver(opsFrame(15, append(TAIL_TEXT.length, '丙')))
    await vi.waitFor(
      () => {
        expect(pages).toBe(2)
      },
      { timeout: 5_000 },
    )
  })

  it('收到 reset 就重拉基线，不拿那份空快照当内容', async () => {
    let pages = 0
    server.use(
      http.get('*/api/conversations/c1/transcript', () => {
        pages += 1
        return HttpResponse.json(mockTranscriptPage())
      }),
    )

    const { reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })

    // reset 的 items 恒为空，历史必须通过 REST 恢复。
    socket.deliver(resetFrame(30))

    await vi.waitFor(() => {
      expect(pages).toBe(2)
    })
    expect(textOf(reader)).toContain(TAIL_TEXT)
  })

  it('挂载、卸载、再挂载只拉一次基线（严格模式的效果次序）', async () => {
    let pages = 0
    server.use(
      http.get('*/api/conversations/c1/transcript', () => {
        pages += 1
        return HttpResponse.json(mockTranscriptPage())
      }),
    )

    const socket = new FakeSocket()
    const connection = new TranscriptConnection({
      createSocket: () => socket as unknown as WebSocket,
      url: 'ws://test/api/ws',
    })
    connection.connect()
    const reader = new TranscriptReader('c1', connection)
    reader.start()
    reader.stop()
    reader.start()
    socket.deliver(HELLO)

    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })
    // 等待串行队列继续执行，确认没有第二次基线请求。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pages).toBe(1)
  })

  it('工具帧上给人看的那份结果（metadata）过了协议校验还在', async () => {
    const { reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })

    const metadata = { items: [{ caption: 'S01 · 产品特写', url: 'https://example.com/a.png' }] }
    socket.deliver(
      opsFrame(11, [
        {
          frame: {
            display: { kind: 'generic', summary: '出镜头帧' },
            frameId: 't2.1.f9',
            kind: 'tool',
            metadata,
            name: 'generate_shot_frames',
            state: 'done',
            toolCallId: 'call_frames',
            view: 'media_grid',
          },
          op: 'frame.upsert',
          stepId: 't2.1',
          turnId: 't2',
        },
      ]),
    )

    await vi.waitFor(() => {
      const frame = reader
        .view()
        .items.flatMap((item) => (item.kind === 'turn' ? item.steps : []))
        .flatMap((step) => step.frames)
        .find((entry) => entry.frameId === 't2.1.f9')
      expect(frame?.kind === 'tool' ? frame.metadata : undefined).toEqual(metadata)
    })
  })

  it('待回应的交互进 view，回应之后跟着撤掉', async () => {
    const { reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })

    const interaction = {
      interactionId: 'appr_1',
      interactionKind: 'approval',
      state: 'pending',
      toolCallId: 'call_cover',
    }
    socket.deliver(opsFrame(11, [{ interaction, op: 'interaction.upsert' }]))

    await vi.waitFor(() => {
      expect(reader.view().pendingInteractions).toEqual([interaction])
    })

    socket.deliver(
      opsFrame(12, [
        { interaction: { ...interaction, state: 'approved' }, op: 'interaction.upsert' },
      ]),
    )

    await vi.waitFor(() => {
      expect(reader.view().pendingInteractions).toEqual([])
    })
  })

  it('读子代理那条流：REST 带 agent_id，订阅表里是它的 id，reset 也认它', async () => {
    let asked = ''
    server.use(
      http.get('*/api/conversations/c1/transcript', ({ request }) => {
        asked = new URL(request.url).searchParams.get('agent_id') ?? ''
        return HttpResponse.json({ ...mockTranscriptPage(), agent_id: 'run-child' })
      }),
    )
    const socket = new FakeSocket()
    const connection = new TranscriptConnection({
      createSocket: () => socket as unknown as WebSocket,
      url: 'ws://test/api/ws',
    })
    connection.connect()
    const reader = new TranscriptReader('c1', connection, 'delta', 'run-child')
    reader.start()
    socket.deliver(HELLO)

    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })
    expect(asked).toBe('run-child')
    const table = JSON.parse(socket.sent.find((raw) => raw.includes('subscribe_v2')) ?? '{}') as {
      payload?: { transcript?: Record<string, string> }
    }
    expect(table.payload?.transcript).toEqual({ 'run-child': 'delta' })
  })

  it('停下就把内容清掉，再开从基线重来', async () => {
    const { reader, socket } = startReader()
    await vi.waitFor(() => {
      expect(reader.view().status).toBe('ready')
    })

    reader.stop()
    expect(reader.view().status).toBe('loading')
    expect(reader.view().items).toEqual([])
    expect(socket.sent.some((raw) => raw.includes('unsubscribe_v2'))).toBe(true)
  })

  it('对话不存在就停在错误态，不一直重试', async () => {
    let pages = 0
    server.use(
      http.get('*/api/conversations/c1/transcript', () => {
        pages += 1
        return new HttpResponse(null, { status: 404 })
      }),
    )

    const { reader } = startReader()

    await vi.waitFor(() => {
      expect(reader.view().status).toBe('error')
    })
    expect(pages).toBe(1)
  })
})
