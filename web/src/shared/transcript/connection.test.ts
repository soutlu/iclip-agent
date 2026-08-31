/**
 * 订阅连接的水位记账与分流。
 *
 * 这几条错了都不报错：界面安静地停止更新、少一段内容而自己不知道、或者把别段对话的内容画到
 * 当前这段里。所以每条各有一个用例。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TranscriptConnection, type TranscriptOps } from './connection'

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

  frames(): Array<{ type: string; id?: string; payload?: Record<string, unknown> }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string })
  }
}

const SNAPSHOT = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
}

function reset(seq: number, conversationId = 'c1') {
  return {
    type: 'transcript.reset',
    session_id: conversationId,
    payload: { agent_id: 'main', snapshot: SNAPSHOT, has_more_older: true, seq },
  }
}

function ops(seq: number, conversationId = 'c1', list: TranscriptOps = []) {
  return {
    type: 'transcript.ops',
    session_id: conversationId,
    payload: { agent_id: 'main', ops: list, seq },
  }
}

const HELLO = {
  type: 'server_hello',
  payload: { ws_connection_id: 'w1', protocol_version: 2, heartbeat_ms: 10_000 },
}

describe('TranscriptConnection', () => {
  let socket: FakeSocket
  let received: Array<[string, TranscriptOps]>
  let accept: boolean

  /** 一条连接，订上给的那几段对话。收到的每一批都记下是哪段的。 */
  function connect(conversationIds: string[] = ['c1'], now = () => 1_000) {
    socket = new FakeSocket()
    received = []
    accept = true
    const connection = new TranscriptConnection({
      url: 'ws://test/ws',
      now,
      createSocket: () => socket as unknown as WebSocket,
    })
    connection.connect()
    for (const conversationId of conversationIds) {
      connection.subscribe(conversationId, {
        onReset: () => received.push([conversationId, []]),
        onOps: (_agent, list) => {
          received.push([conversationId, list])
          return accept
        },
      })
    }
    socket.deliver(HELLO)
    return connection
  }

  beforeEach(() => {
    vi.useRealTimers()
  })

  it('连上之后逐段订，头一次不带水位', () => {
    connect(['c1', 'c2'])

    const sent = socket.frames()
    expect(sent.map((f) => f.type)).toEqual(['subscribe_v2', 'subscribe_v2'])
    expect(sent.map((f) => f.payload?.['session_id'])).toEqual(['c1', 'c2'])
    // 不带 transcript_since，服务端据此判「第一次订阅」，回一帧 reset。
    expect(sent[0]?.payload).not.toHaveProperty('transcript_since')
  })

  it('按 session_id 分流：一段对话的批次不进另一段', () => {
    const connection = connect(['c1', 'c2'])

    socket.deliver(ops(3, 'c1'))
    socket.deliver(ops(9, 'c2'))

    expect(received.map(([conversationId]) => conversationId)).toEqual(['c1', 'c2'])
    // 水位各记各的：混在一起的话，切到另一段会拿着别人的号去补批。
    expect(connection.watermarkOf('c1', 'main')).toBe(3)
    expect(connection.watermarkOf('c2', 'main')).toBe(9)
  })

  it('没订的那段对话的帧直接丢掉', () => {
    const connection = connect(['c1'])

    socket.deliver(ops(4, 'c-someone-else'))

    expect(received).toHaveLength(0)
    expect(connection.watermarkOf('c-someone-else', 'main')).toBeUndefined()
  })

  it('reset 无条件把水位覆写回去，哪怕手上的更大', () => {
    const connection = connect()

    socket.deliver(ops(42))
    expect(connection.watermarkOf('c1', 'main')).toBe(42)

    // 服务端重启了，号从头来。不退回去的话，之后每一批都会被当成旧的丢掉。
    socket.deliver(reset(1))
    expect(connection.watermarkOf('c1', 'main')).toBe(1)
  })

  it('上层没吃下这一批就不推进水位', () => {
    const connection = connect()

    socket.deliver(ops(7))
    expect(connection.watermarkOf('c1', 'main')).toBe(7)

    accept = false
    socket.deliver(ops(8))
    // 推了的话这一批再也补不回来了。
    expect(connection.watermarkOf('c1', 'main')).toBe(7)
  })

  it('断线重连之后逐段重订，各带自己那段的水位', () => {
    vi.useFakeTimers()
    const connection = connect(['c1', 'c2'])
    socket.deliver(ops(5, 'c1'))
    socket.deliver(ops(6, 'c2'))
    const before = socket

    before.onclose?.()
    vi.advanceTimersByTime(2_000)
    // connect() 会用同一个工厂，但工厂给的是原来那个 socket 对象；重订的帧照样发在它上面。
    socket.deliver(HELLO)

    const resubscribed = before
      .frames()
      .filter((frame) => frame.type === 'subscribe_v2')
      .slice(2)
    expect(resubscribed.map((frame) => frame.payload?.['transcript_since'])).toEqual([
      { main: 5 },
      { main: 6 },
    ])
    expect(connection.watermarkOf('c1', 'main')).toBe(5)
    vi.useRealTimers()
  })

  it('服务端说这段订不上，就不再留着它', () => {
    const connection = connect(['c1'])
    let refused = false
    connection.subscribe('c-gone', {
      onReset: () => {},
      onOps: () => true,
      onNotFound: () => {
        refused = true
      },
    })

    const asked = socket.frames().find((frame) => frame.payload?.['session_id'] === 'c-gone')
    socket.deliver({ type: 'ack', id: asked?.id, payload: { not_found: ['c-gone'] } })

    expect(refused).toBe(true)
    // 留着的话，每次重连都会去订同一段、每次都被拒。
    socket.deliver(ops(1, 'c-gone'))
    expect(received).toHaveLength(0)
  })

  it('ping 照着 nonce 回 pong', () => {
    connect()

    socket.deliver({ type: 'ping', payload: { nonce: 'abc' } })

    expect(socket.frames().at(-1)).toEqual({ type: 'pong', payload: { nonce: 'abc' } })
  })

  it('形状不对的帧丢掉，不动水位', () => {
    const connection = connect()

    socket.deliver(ops(5))
    socket.deliver({ type: 'transcript.ops', session_id: 'c1', payload: { seq: 6 } })

    expect(connection.watermarkOf('c1', 'main')).toBe(5)
    expect(received).toHaveLength(1)
  })

  it('太久没有任何入站帧就算 stale', () => {
    let clock = 1_000
    const connection = connect(['c1'], () => clock)

    expect(connection.health().stale).toBe(false)
    // 心跳 10 秒，下限 30 秒，所以判据是 30 秒。
    clock += 31_000
    expect(connection.health().stale).toBe(true)
  })
})
