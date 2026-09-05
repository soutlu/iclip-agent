import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeSocket } from '@/testing/ws'
import { TranscriptConnection, type SessionUpdate, type TranscriptOps } from './connection'

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
    expect(sent[0]?.payload).not.toHaveProperty('transcript_since')
  })

  it('按 session_id 分流：一段对话的批次不进另一段', () => {
    const connection = connect(['c1', 'c2'])

    socket.deliver(ops(3, 'c1'))
    socket.deliver(ops(9, 'c2'))

    expect(received.map(([conversationId]) => conversationId)).toEqual(['c1', 'c2'])
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

    // 模拟服务端重启后批次号归一，验证 reset 允许水位回退。
    socket.deliver(reset(1))
    expect(connection.watermarkOf('c1', 'main')).toBe(1)
  })

  it('上层没吃下这一批就不推进水位', () => {
    const connection = connect()

    socket.deliver(ops(7))
    expect(connection.watermarkOf('c1', 'main')).toBe(7)

    accept = false
    socket.deliver(ops(8))
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
    // 测试工厂复用原 socket，重订帧仍发送到同一对象。
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
    socket.deliver(ops(1, 'c-gone'))
    expect(received).toHaveLength(0)
  })

  it('档位随订阅上行，调高之后重订并把水位照旧带上', () => {
    const connection = connect(['c1'])
    const handlers = { onReset: () => received.push(['c1', []]), onOps: () => true }

    connection.subscribe('c1', handlers, 'turn')
    socket.deliver(ops(4, 'c1'))
    connection.subscribe('c1', handlers, 'delta')

    const grades = socket
      .frames()
      .filter((frame) => frame.type === 'subscribe_v2')
      .map((frame) => (frame.payload?.['transcript'] as { main?: string } | undefined)?.main)
    expect(grades).toEqual(['delta', 'turn', 'delta'])
    expect(connection.watermarkOf('c1', 'main')).toBe(4)
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
    // 心跳为 10 秒，但失活阈值受 30 秒下限约束。
    clock += 31_000
    expect(connection.health().stale).toBe(true)
  })

  it('reconnect() 立刻换一条新连接，带着水位重订，旧的那条不再排退避', () => {
    const sockets: FakeSocket[] = []
    let clock = 1_000
    const connection = new TranscriptConnection({
      url: 'ws://test/ws',
      now: () => clock,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    connection.connect()
    connection.subscribe('c1', { onReset: () => undefined, onOps: () => true })
    sockets[0]?.deliver(HELLO)
    sockets[0]?.deliver(ops(7))
    expect(connection.watermarkOf('c1', 'main')).toBe(7)

    clock += 31_000
    connection.reconnect()

    expect(sockets).toHaveLength(2)
    expect(sockets[0]?.onclose).toBeNull()

    sockets[1]?.deliver(HELLO)
    const sent = sockets[1]?.frames() ?? []
    expect(sent[0]?.type).toBe('subscribe_v2')
    expect(sent[0]?.payload?.['transcript_since']).toEqual({ main: 7 })
  })

  it('两种全局帧都不看订阅：一段都没订也收得到', () => {
    const connection = connect([])
    const seen: SessionUpdate[] = []
    connection.watchSessions((update) => seen.push(update))

    socket.deliver({
      type: 'session.meta.updated',
      payload: { session_id: 'c9', title: '夜景延时素材生成' },
    })
    // 运行帧省略结束原因，上层应规范化为 null。
    socket.deliver({
      type: 'event.session.work_changed',
      session_id: 'c9',
      payload: { busy: true, pending_interaction: 'approval' },
    })
    socket.deliver({
      type: 'event.session.work_changed',
      session_id: 'c9',
      payload: { busy: false, pending_interaction: 'none', last_turn_reason: 'failed' },
    })

    expect(seen).toEqual([
      { conversationId: 'c9', kind: 'title', title: '夜景延时素材生成' },
      {
        busy: true,
        conversationId: 'c9',
        kind: 'activity',
        lastTurnReason: null,
        pendingInteraction: 'approval',
      },
      {
        busy: false,
        conversationId: 'c9',
        kind: 'activity',
        lastTurnReason: 'failed',
        pendingInteraction: 'none',
      },
    ])
  })

  it('退订之后不再收', () => {
    const connection = connect([])
    const seen: SessionUpdate[] = []
    const stop = connection.watchSessions((update) => seen.push(update))

    stop()
    socket.deliver({ type: 'session.meta.updated', payload: { session_id: 'c9', title: '新名字' } })

    expect(seen).toEqual([])
  })

  it('订文件：发 watch_fs_add，变动按对话与路径分给它的 handler', () => {
    const connection = connect(['c1'])
    const seen: string[] = []
    connection.watchFs('c1', ['video_shot.json'], (changes) => {
      for (const change of changes) seen.push(change.path)
    })

    const asked = socket.frames().find((frame) => frame.type === 'watch_fs_add')
    expect(asked?.payload).toEqual({ paths: ['video_shot.json'], session_id: 'c1' })

    socket.deliver({
      type: 'event.fs.changed',
      session_id: 'c1',
      payload: {
        changes: [
          { path: 'video_shot.json', change: 'modified', kind: 'file' },
          { path: 'frames/extraction.json', change: 'created', kind: 'file' },
        ],
        coalesced_window_ms: 0,
      },
    })

    expect(seen).toEqual(['video_shot.json'])
  })

  it('别段对话的文件变动不串门', () => {
    const connection = connect(['c1'])
    const seen: string[] = []
    connection.watchFs('c1', ['video_shot.json'], () => seen.push('called'))

    socket.deliver({
      type: 'event.fs.changed',
      session_id: 'c2',
      payload: {
        changes: [{ path: 'video_shot.json', change: 'modified', kind: 'file' }],
        coalesced_window_ms: 0,
      },
    })

    expect(seen).toEqual([])
  })

  it('退订之后发 watch_fs_remove，也不再收变动', () => {
    const connection = connect(['c1'])
    const seen: string[] = []
    const stop = connection.watchFs('c1', ['video_shot.json'], () => seen.push('called'))

    stop()
    expect(socket.frames().some((frame) => frame.type === 'watch_fs_remove')).toBe(true)

    socket.deliver({
      type: 'event.fs.changed',
      session_id: 'c1',
      payload: {
        changes: [{ path: 'video_shot.json', change: 'modified', kind: 'file' }],
        coalesced_window_ms: 0,
      },
    })

    expect(seen).toEqual([])
  })

  it('断线重连之后把还在的文件订阅原样重发', () => {
    vi.useFakeTimers()
    const connection = connect(['c1'])
    connection.watchFs('c1', ['video_shot.json'], () => {})
    const before = socket

    before.onclose?.()
    vi.advanceTimersByTime(2_000)
    socket.deliver(HELLO)

    const watches = before.frames().filter((frame) => frame.type === 'watch_fs_add')
    expect(watches).toHaveLength(2)
    vi.useRealTimers()
  })
})
