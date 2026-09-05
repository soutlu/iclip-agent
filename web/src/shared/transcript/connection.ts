/** 参考 Kimi 客户端，一条连接按 session_id 分派多段对话；改名与活动全局帧经 watchSessions 分发。重连携带各 agent 的已应用水位。 */

import { z } from 'zod'

import { transcriptOpsEventSchema, transcriptResetEventSchema } from './vendor/contract/events'
import type { TranscriptGrade } from './vendor/granularity/grade'

export type { TranscriptGrade }

/** 类型从校验 schema 推导，避免重复声明造成可选字段差异。 */
type ResetEvent = z.infer<typeof transcriptResetEventSchema>
type OpsEvent = z.infer<typeof transcriptOpsEventSchema>

export type TranscriptSnapshot = ResetEvent['snapshot'] & { hasMoreOlder: boolean }
export type TranscriptOps = OpsEvent['ops']

const DEFAULT_HEARTBEAT_MS = 30_000

const STALE_FLOOR_MS = 30_000

const MAX_RECONNECT_DELAY_MS = 30_000

/** 加入随机抖动，避免客户端集中重连。 */
const RECONNECT_JITTER_MS = 250

export interface TranscriptHandlers {
  /** snapshot.items 恒为空；历史由 REST 分页提供，reset 只携带全局实体和水位。 */
  onReset(agentId: string, snapshot: TranscriptSnapshot, seq: number | undefined): void
  /** seq 用于检测批次缺口；返回 false 表示未应用，不推进水位，允许后续补发。 */
  onOps(agentId: string, ops: TranscriptOps, seq: number | undefined): boolean | void
  onNotFound?(): void
}

export interface TranscriptConnectionOptions {
  url: string
  /** 连接级状态回调，不按对话分别通知。 */
  onConnectionState?: (connected: boolean) => void
  createSocket?: (url: string) => WebSocket
  now?: () => number
}

/** 全局帧单独校验，不修改 vendor 协议；放入 TranscriptMeta 会被其 schema 丢弃未知字段。 */
const titleSchema = z.object({ session_id: z.string(), title: z.string() })

// session_id 位于信封；last_turn_reason 在运行时可能省略，结束时提供。
const workChangedSchema = z.object({
  busy: z.boolean(),
  pending_interaction: z.enum(['none', 'approval', 'question']),
  last_turn_reason: z.enum(['completed', 'failed', 'aborted']).nullable().optional(),
})

// session_id 位于信封；版本与写入者从重新读取的文件获取。
const fsChangedSchema = z.object({
  changes: z.array(
    z.object({
      path: z.string(),
      change: z.enum(['created', 'modified', 'deleted']),
      kind: z.string(),
    }),
  ),
  coalesced_window_ms: z.number(),
})

export type FsChange = z.infer<typeof fsChangedSchema>['changes'][number]

/** 全局事件不补发；reconnected 是本地通知，调用方据此刷新断线期间可能变化的列表。 */
export type SessionUpdate =
  | { kind: 'title'; conversationId: string; title: string }
  | {
      kind: 'activity'
      conversationId: string
      busy: boolean
      pendingInteraction: 'none' | 'approval' | 'question'
      /** 未提供结束原因时为 null。 */
      lastTurnReason: 'completed' | 'failed' | 'aborted' | null
    }
  | { kind: 'reconnected' }

export interface ConnectionHealth {
  connected: boolean
  /** 超过心跳阈值未收到入站帧时为 true。 */
  stale: boolean
}

interface FsWatch {
  paths: readonly string[]
  handler: (changes: readonly FsChange[]) => void
}

interface Subscription {
  handlers: TranscriptHandlers
  /** 当前会话使用 delta；侧栏使用仅含轮次与审批的 turn 档。 */
  grade: TranscriptGrade
  /** 按 agent 保存已应用批次号，重连时用于补发或重置。 */
  watermarks: Map<string, number>
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
  private everOpened = false

  private subscriptions = new Map<string, Subscription>()

  /** 请求 ID 映射到对话 ID，用于处理订阅拒绝回执。 */
  private pending = new Map<string, string>()

  private fsWatches = new Map<string, Set<FsWatch>>()

  private sessionWatchers = new Set<(update: SessionUpdate) => void>()

  private readonly options: TranscriptConnectionOptions

  constructor(options: TranscriptConnectionOptions) {
    this.options = options
  }

  connect(): void {
    if (this.socket !== null) return
    // 允许 close 后重新 connect，兼容 React StrictMode 的清理与重挂载。
    this.closed = false
    this.lastActivityAt = this.now()
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.options.url)
    this.socket = socket
    socket.onmessage = (event) => {
      // 所有入站消息均刷新活跃时间，独立于帧是否合法。
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

  /** 立即重连并跳过退避；先移除旧 socket 回调，避免 onclose 再次排入退避。 */
  reconnect(): void {
    if (this.closed) return
    this.clearTimer()
    const stale = this.socket
    this.detach()
    stale?.close(1000)
    this.reconnectAttempts = 0
    this.connect()
  }

  /** 更新订阅时保留水位；提高粒度时服务端先发 reset，补足低粒度未下发的内容。 */
  subscribe(
    conversationId: string,
    handlers: TranscriptHandlers,
    grade: TranscriptGrade = 'delta',
  ): void {
    const existing = this.subscriptions.get(conversationId)
    this.subscriptions.set(conversationId, {
      handlers,
      grade,
      watermarks: existing?.watermarks ?? new Map(),
    })
    if (this.connected) this.sendSubscribe(conversationId)
  }

  /** 退订时清除水位，重新订阅需拉取基线。 */
  unsubscribe(conversationId: string): void {
    if (!this.subscriptions.delete(conversationId)) return
    this.send({
      type: 'unsubscribe_v2',
      id: this.mintId(),
      payload: { session_id: conversationId },
    })
  }

  /** 文件订阅独立于 transcript；重连重发订阅，调用方须重拉以补偿断线期间丢失的文件通知。 */
  watchFs(
    conversationId: string,
    paths: readonly string[],
    handler: (changes: readonly FsChange[]) => void,
  ): () => void {
    const watch: FsWatch = { handler, paths }
    const watches = this.fsWatches.get(conversationId) ?? new Set<FsWatch>()
    watches.add(watch)
    this.fsWatches.set(conversationId, watches)
    if (this.connected) this.sendFsWatch('watch_fs_add', conversationId, paths)
    return () => {
      const current = this.fsWatches.get(conversationId)
      if (current === undefined || !current.delete(watch)) return
      if (current.size === 0) this.fsWatches.delete(conversationId)
      this.sendFsWatch('watch_fs_remove', conversationId, paths)
    }
  }

  /** 监听所有会话的全局更新，返回取消监听函数。 */
  watchSessions(watcher: (update: SessionUpdate) => void): () => void {
    this.sessionWatchers.add(watcher)
    return () => void this.sessionWatchers.delete(watcher)
  }

  health(): ConnectionHealth {
    const limit = Math.max(this.heartbeatMs * 2, STALE_FLOOR_MS)
    return {
      connected: this.connected,
      stale: this.lastActivityAt > 0 && this.now() - this.lastActivityAt > limit,
    }
  }

  watermarkOf(conversationId: string, agentId: string): number | undefined {
    return this.subscriptions.get(conversationId)?.watermarks.get(agentId)
  }

  /** REST 基线和补批也须报告已应用水位，避免重连时重复请求完整基线。 */
  markApplied(conversationId: string, agentId: string, seq: number): void {
    this.subscriptions.get(conversationId)?.watermarks.set(agentId, seq)
  }

  private receive(raw: unknown): void {
    let frame: { type?: unknown; id?: unknown; session_id?: unknown; payload?: unknown }
    try {
      frame = JSON.parse(String(raw)) as typeof frame
    } catch {
      return
    }
    if (typeof frame.type !== 'string') return

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
      case 'ack': {
        this.settleAck(frame)
        return
      }
      case 'session.meta.updated': {
        const parsed = titleSchema.safeParse(frame.payload)
        if (!parsed.success) return
        this.announce({
          conversationId: parsed.data.session_id,
          kind: 'title',
          title: parsed.data.title,
        })
        return
      }
      case 'event.session.work_changed': {
        if (typeof frame.session_id !== 'string') return
        const parsed = workChangedSchema.safeParse(frame.payload)
        if (!parsed.success) return
        this.announce({
          busy: parsed.data.busy,
          conversationId: frame.session_id,
          kind: 'activity',
          lastTurnReason: parsed.data.last_turn_reason ?? null,
          pendingInteraction: parsed.data.pending_interaction,
        })
        return
      }
      case 'event.fs.changed': {
        if (typeof frame.session_id !== 'string') return
        const parsed = fsChangedSchema.safeParse(frame.payload)
        if (!parsed.success) return
        const watches = this.fsWatches.get(frame.session_id)
        if (watches === undefined) return
        for (const watch of watches) {
          const mine = parsed.data.changes.filter((change) => watch.paths.includes(change.path))
          if (mine.length > 0) watch.handler(mine)
        }
        return
      }
      case 'transcript.reset':
      case 'transcript.ops': {
        if (typeof frame.session_id !== 'string') return
        const subscription = this.subscriptions.get(frame.session_id)
        if (subscription === undefined) return
        this.apply(frame.type, subscription, { type: frame.type, ...(frame.payload as object) })
        return
      }
      default:
        return
    }
  }

  private announce(update: SessionUpdate): void {
    for (const watcher of this.sessionWatchers) watcher(update)
  }

  private apply(type: string, subscription: Subscription, wrapped: object): void {
    if (type === 'transcript.reset') {
      const parsed = transcriptResetEventSchema.safeParse(wrapped)
      if (!parsed.success) return
      const { agent_id, snapshot, has_more_older, seq } = parsed.data
      subscription.handlers.onReset(agent_id, { ...snapshot, hasMoreOlder: has_more_older }, seq)
      // reset 无条件覆盖水位：服务端重启可能从 1 重新编号。
      if (seq !== undefined) subscription.watermarks.set(agent_id, seq)
      return
    }
    const parsed = transcriptOpsEventSchema.safeParse(wrapped)
    if (!parsed.success) return
    const { agent_id, ops, seq } = parsed.data
    const accepted = subscription.handlers.onOps(agent_id, ops, seq)
    // 仅已接受的批次推进水位，未应用的批次需保留补发机会。
    if (accepted !== false && seq !== undefined) subscription.watermarks.set(agent_id, seq)
  }

  private settleAck(frame: { id?: unknown; payload?: unknown }): void {
    if (typeof frame.id !== 'string') return
    const asked = this.pending.get(frame.id)
    this.pending.delete(frame.id)
    if (asked === undefined) return
    const refused = (frame.payload as { not_found?: unknown })?.not_found
    if (!Array.isArray(refused) || !refused.includes(asked)) return
    // 移除被拒绝的订阅，避免重连后重复请求。
    const subscription = this.subscriptions.get(asked)
    this.subscriptions.delete(asked)
    subscription?.handlers.onNotFound?.()
  }

  private opened(): void {
    const reopened = this.everOpened
    this.everOpened = true
    this.connected = true
    this.reconnectAttempts = 0
    this.options.onConnectionState?.(true)
    for (const conversationId of this.subscriptions.keys()) this.sendSubscribe(conversationId)
    for (const [conversationId, watches] of this.fsWatches) {
      for (const watch of watches) this.sendFsWatch('watch_fs_add', conversationId, watch.paths)
    }
    if (reopened) this.announce({ kind: 'reconnected' })
  }

  /** 文件订阅不进入 transcript 的 pending 表，避免文件拒绝回执撤销对话订阅。 */
  private sendFsWatch(
    type: 'watch_fs_add' | 'watch_fs_remove',
    conversationId: string,
    paths: readonly string[],
  ): void {
    this.send({
      type,
      id: this.mintId(),
      payload: { session_id: conversationId, paths: [...paths] },
    })
  }

  private sendSubscribe(conversationId: string): void {
    const subscription = this.subscriptions.get(conversationId)
    if (subscription === undefined) return
    const since = subscription.watermarks.get('main')
    const id = this.mintId()
    this.pending.set(id, conversationId)
    this.send({
      type: 'subscribe_v2',
      id,
      payload: {
        session_id: conversationId,
        transcript: { main: subscription.grade },
        // 首次订阅省略 transcript_since，服务端据此发送 reset。
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

  private dropped(): void {
    this.detach()
    this.scheduleReconnect()
  }

  private detach(): void {
    if (this.socket !== null) {
      this.socket.onmessage = null
      this.socket.onclose = null
      this.socket.onerror = null
      this.socket = null
    }
    this.pending.clear()
    if (this.connected) {
      this.connected = false
      this.options.onConnectionState?.(false)
    }
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
