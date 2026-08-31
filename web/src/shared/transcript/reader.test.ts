/**
 * 读取端的补漏纪律：这几条错了都不报错——界面少一段内容、或者停在空白，自己不知道。
 */

import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { mockTranscriptPage } from '@/testing/mocks/transcript'
import { TranscriptConnection } from './connection'
import { TranscriptReader } from './reader'

/** 历史最后一轮里模型说的那句，追加的位置照它算。 */
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

/** 一批追加操作：往历史最后那句后面接一段。 */
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

/** 起一个读取端，连接用假 socket。 */
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

/** 时间线里所有正文块拼起来，断言用。 */
const textOf = (reader: TranscriptReader): string =>
  reader
    .view()
    .items.flatMap((item) => (item.kind === 'turn' ? item.steps : []))
    .flatMap((step) => step.frames)
    .map((frame) => ('text' in frame ? frame.text : ''))
    .join('|')

describe('TranscriptReader', () => {
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
    // 基线在飞的时候到的这一批：当场落地会被随后那份基线整个盖掉。
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

    // 11 没收到，直接来了 12。
    socket.deliver(opsFrame(12, append(TAIL_TEXT.length + 1, '乙')))
    // 没吃下就不推进水位：推了的话缺的那批再也要不回来。
    expect(connection.watermarkOf('c1', 'main')).toBe(10)

    await vi.waitFor(() => {
      expect(textOf(reader)).toContain(`${TAIL_TEXT}甲乙`)
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

    // 服务端的 reset 里 items 恒空（历史走 REST 分页）；照它落地会把界面清成白的。
    socket.deliver(resetFrame(30))

    await vi.waitFor(() => {
      expect(pages).toBe(2)
    })
    expect(textOf(reader)).toContain(TAIL_TEXT)
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
