/**
 * 订阅连接的水位记账。
 *
 * 这三条错了都不报错：界面安静地停止更新、或者少一段内容而自己不知道。所以每条各有一个用例。
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

  frames(): Array<{ type: string; payload?: Record<string, unknown> }> {
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

function reset(seq: number) {
  return {
    type: 'transcript.reset',
    session_id: 'c1',
    payload: { agent_id: 'main', snapshot: SNAPSHOT, has_more_older: true, seq },
  }
}

function ops(seq: number, list: TranscriptOps = []) {
  return {
    type: 'transcript.ops',
    session_id: 'c1',
    payload: { agent_id: 'main', ops: list, seq },
  }
}

const HELLO = {
  type: 'server_hello',
  payload: { ws_connection_id: 'w1', protocol_version: 2, heartbeat_ms: 10_000 },
}

describe('TranscriptConnection', () => {
  let socket: FakeSocket
  let received: TranscriptOps[]
  let accept: boolean

  function connect(now = () => 1_000) {
    socket = new FakeSocket()
    received = []
    accept = true
    const connection = new TranscriptConnection({
      url: 'ws://test/ws',
      conversationId: 'c1',
      now,
      createSocket: () => socket as unknown as WebSocket,
      handlers: {
        onReset: () => received.push([]),
        onOps: (_agent, list) => {
          received.push(list)
          return accept
        },
      },
    })
    connection.connect()
    socket.deliver(HELLO)
    return connection
  }

  beforeEach(() => {
    vi.useRealTimers()
  })

  it('先握手再订阅，头一次不带水位', () => {
    connect()

    const sent = socket.frames()
    expect(sent.map((f) => f.type)).toEqual(['client_hello', 'subscribe_v2'])
    // 不带 transcript_since，服务端据此判「第一次订阅」，回一帧 reset。
    expect(sent[1]?.payload).not.toHaveProperty('transcript_since')
  })

  it('reset 无条件把水位覆写回去，哪怕手上的更大', () => {
    const connection = connect()

    socket.deliver(ops(42))
    expect(connection.watermarkOf('main')).toBe(42)

    // 服务端重启了，号从头来。不退回去的话，之后每一批都会被当成旧的丢掉。
    socket.deliver(reset(1))
    expect(connection.watermarkOf('main')).toBe(1)
  })

  it('上层没吃下这一批就不推进水位', () => {
    const connection = connect()

    socket.deliver(ops(7))
    expect(connection.watermarkOf('main')).toBe(7)

    accept = false
    socket.deliver(ops(8))
    // 推了的话这一批再也补不回来了。
    expect(connection.watermarkOf('main')).toBe(7)
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

    expect(connection.watermarkOf('main')).toBe(5)
    expect(received).toHaveLength(1)
  })

  it('太久没有任何入站帧就算 stale', () => {
    let clock = 1_000
    const connection = connect(() => clock)

    expect(connection.health().stale).toBe(false)
    // 心跳 10 秒，下限 30 秒，所以判据是 30 秒。
    clock += 31_000
    expect(connection.health().stale).toBe(true)
  })
})
