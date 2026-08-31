/**
 * transcript 的订阅连接：连上、订阅、记水位、断了自己接回来。
 *
 * 帧的形状不在这里写，走 vendor 里那份照抄来的 zod（`contract/events.ts`）——服务端发的每一帧
 * 都按它校验，形状对不上整帧丢掉。
 *
 * **水位记账是这个文件的全部要点**，规则照 kimi 出厂客户端：
 *
 * 1. 收到 `transcript.reset` → 水位**无条件**覆写成帧里的 seq（不是取较大值）。服务端进程重启
 *    后批次号会从 1 重来，客户端不退回去的话，之后每一批都被当成旧的丢掉，界面就此不再更新。
 * 2. 收到 `transcript.ops` → 先交给上层应用；上层返回 `false`（没吃下）就**不推进水位**，下次
 *    补批还会把它带回来。
 * 3. 任何入站帧都刷新活跃时刻；`ping` 照着 nonce 回一帧 `pong`。
 */

import type { z } from 'zod'

import { transcriptOpsEventSchema, transcriptResetEventSchema } from './vendor/contract/events'

/**
 * 交给上层的形状取自 schema 本身，不取 vendor 里那几个 interface：校验出来的就是这一份，
 * 中间再声明一次只会在两边的可选字段口径上打架。
 */
type ResetEvent = z.infer<typeof transcriptResetEventSchema>
type OpsEvent = z.infer<typeof transcriptOpsEventSchema>

export type TranscriptSnapshot = ResetEvent['snapshot'] & { hasMoreOlder: boolean }
export type TranscriptOps = OpsEvent['ops']

/** 没收到 server_hello 之前按这个算心跳间隔。服务端会在 hello 里告诉我们真实值。 */
const DEFAULT_HEARTBEAT_MS = 30_000

/** 判「没动静了」的下限：即使服务端报了一个很短的心跳，也不会比这个更急躁。 */
const STALE_FLOOR_MS = 30_000

const MAX_RECONNECT_DELAY_MS = 30_000

/** 退避里掺的随机量，避免一堆客户端同时回来。 */
const RECONNECT_JITTER_MS = 250

export interface TranscriptHandlers {
  /**
   * 整份状态换掉了。`snapshot.items` 恒为空——历史走 REST 分页，这一帧只带全局实体与水位。
   */
  onReset(agentId: string, snapshot: TranscriptSnapshot): void
  /**
   * 来了一批操作。返回 `false` 表示没吃下（例如发现缺口要重拉），那样水位不会推进。
   */
  onOps(agentId: string, ops: TranscriptOps): boolean | void
  onConnectionState?(connected: boolean): void
}

export interface TranscriptConnectionOptions {
  url: string
  conversationId: string
  handlers: TranscriptHandlers
  /** 测试用：换掉 WebSocket 实现与时钟。 */
  createSocket?: (url: string) => WebSocket
  now?: () => number
}

export interface ConnectionHealth {
  connected: boolean
  /** 太久没有任何入站帧了。界面据此提示「连接可能断了」。 */
  stale: boolean
}

export class TranscriptConnection {
  private socket: WebSocket | null = null
  private connected = false
  private closed = false
  private heartbeatMs = DEFAULT_HEARTBEAT_MS
  private lastActivityAt = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 0

  /**
   * 每个 agent 收到的最后一个批次号。重连时报给服务端，它据此决定补批还是整页重来。
   * 没有这个数就只能每次重连都整页重拉。
   */
  private watermarks = new Map<string, number>()

  private readonly options: TranscriptConnectionOptions

  constructor(options: TranscriptConnectionOptions) {
    this.options = options
  }

  connect(): void {
    if (this.socket !== null || this.closed) return
    this.lastActivityAt = this.now()
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.options.url)
    this.socket = socket
    socket.onmessage = (event) => {
      // 先刷活跃时刻再解析：判「还活着」看的是有没有收到东西，不是收到的东西对不对。
      this.lastActivityAt = this.now()
      this.receive(event.data)
    }
    socket.onclose = () => this.dropped()
    socket.onerror = () => this.dropped()
  }

  close(): void {
    this.closed = true
    this.clearTimer()
    this.socket?.close(1000)
    this.socket = null
    this.connected = false
  }

  health(): ConnectionHealth {
    const limit = Math.max(this.heartbeatMs * 2, STALE_FLOOR_MS)
    return {
      connected: this.connected,
      stale: this.lastActivityAt > 0 && this.now() - this.lastActivityAt > limit,
    }
  }

  /** 供测试与界面查看：这个 agent 手上的水位。 */
  watermarkOf(agentId: string): number | undefined {
    return this.watermarks.get(agentId)
  }

  // --- 收 -------------------------------------------------------------------

  private receive(raw: unknown): void {
    let frame: { type?: unknown; payload?: unknown }
    try {
      frame = JSON.parse(String(raw)) as typeof frame
    } catch {
      return
    }
    if (typeof frame.type !== 'string') return
    const wrapped = { type: frame.type, ...(frame.payload as object) }

    switch (frame.type) {
      case 'server_hello': {
        const beat = (frame.payload as { heartbeat_ms?: number })?.heartbeat_ms
        if (typeof beat === 'number' && beat > 0) this.heartbeatMs = beat
        this.opened()
        return
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: string })?.nonce
        this.send({ type: 'pong', payload: { nonce } })
        return
      }
      case 'transcript.reset': {
        const parsed = transcriptResetEventSchema.safeParse(wrapped)
        if (!parsed.success) return
        const { agent_id, snapshot, has_more_older, seq } = parsed.data
        this.options.handlers.onReset(agent_id, {
          ...snapshot,
          hasMoreOlder: has_more_older,
        })
        // 无条件覆写，不是取较大值：服务端重启后号从 1 重来，我们得跟着退回去。
        if (seq !== undefined) this.watermarks.set(agent_id, seq)
        return
      }
      case 'transcript.ops': {
        const parsed = transcriptOpsEventSchema.safeParse(wrapped)
        if (!parsed.success) return
        const { agent_id, ops, seq } = parsed.data
        const accepted = this.options.handlers.onOps(agent_id, ops)
        // 上层说没吃下就不推进：推了的话这一批再也补不回来。
        if (accepted !== false && seq !== undefined) this.watermarks.set(agent_id, seq)
        return
      }
      default:
        return
    }
  }

  // --- 发 -------------------------------------------------------------------

  private opened(): void {
    this.connected = true
    this.reconnectAttempts = 0
    this.options.handlers.onConnectionState?.(true)
    this.send({
      type: 'client_hello',
      id: this.mintId(),
      payload: { client_id: this.options.conversationId },
    })
    const since = this.watermarks.get('main')
    this.send({
      type: 'subscribe_v2',
      id: this.mintId(),
      payload: {
        session_id: this.options.conversationId,
        transcript: { main: 'delta' },
        // 头一次连没有水位，不带这个字段——服务端据此判「第一次订阅」，回一帧 reset。
        ...(since === undefined ? {} : { transcript_since: { main: since } }),
      },
    })
  }

  private send(frame: unknown): void {
    if (this.socket === null || this.socket.readyState !== 1) return
    this.socket.send(JSON.stringify(frame))
  }

  private mintId(): string {
    this.nextId += 1
    return `c${this.nextId}`
  }

  // --- 断了 -----------------------------------------------------------------

  private dropped(): void {
    if (this.socket !== null) {
      this.socket.onmessage = null
      this.socket.onclose = null
      this.socket.onerror = null
      this.socket = null
    }
    if (this.connected) {
      this.connected = false
      this.options.handlers.onConnectionState?.(false)
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return
    const delay =
      Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempts) +
      Math.floor(Math.random() * RECONNECT_JITTER_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}
