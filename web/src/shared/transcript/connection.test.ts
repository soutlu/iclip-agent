/**
 * 订阅连接的水位记账与分流。
 *
 * 这几条错了都不报错：界面安静地停止更新、少一段内容而自己不知道、或者把别段对话的内容画到
 * 当前这段里。所以每条各有一个用例。
 */

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
    // 水位不丢：升档那一帧照样报上去，由服务端决定补批还是整份换掉（它会选后者）。
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
    // 心跳 10 秒，下限 30 秒，所以判据是 30 秒。
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
    // 旧 socket 的回调已经摘掉：它这会儿才派 onclose，也不会再排一次退避重连
    expect(sockets[0]?.onclose).toBeNull()

    // 新连接带着水位重订，服务端据此补批，不整份重发
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
    // 忙的那一帧不带 last_turn_reason（服务端 exclude_none），到上层归一成 null
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

    // 侧栏列着几十段对话却一段都没订，按订阅分流的话它永远收不到改名与角标。
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

    // 只把订了的那条路径给它：订一份文件的人不该被别的文件叫醒。
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

    // 新连接那一头什么都不记得：不重发的话文件变了再也没人通知。
    const watches = before.frames().filter((frame) => frame.type === 'watch_fs_add')
    expect(watches).toHaveLength(2)
    vi.useRealTimers()
  })
})
