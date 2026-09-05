/** 参考 Kimi 客户端：基线加载前缓冲 WS 批次，加载后按序应用。缺批优先补发，超出窗口重拉；未应用批次必须返回 false，禁止推进水位。 */

import { ApiError } from '@/shared/api/client'
import {
  MAIN_AGENT_ID,
  type TranscriptConnection,
  type TranscriptGrade,
  type TranscriptOps,
} from './connection'
import {
  fetchTranscriptBaseline,
  fetchTranscriptCatchup,
  type TranscriptBatch,
} from './transcript.api'
import {
  AgentTranscript,
  type ActivityMeta,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptPrompt,
} from './vendor'

/** 全量刷新最多三次，之后交由界面显示错误并重试。 */
const MAX_RELOADS = 3

/** 参考 Kimi：第 n 次重拉延迟 n×2 秒，上限 15 秒。 */
const reloadDelayMs = (attempt: number) => Math.min(attempt * 2000, 15_000)

export interface TranscriptView {
  /** 直接使用 transcript meta 判定当前运行状态。 */
  activity: ActivityMeta
  contextTokens: number | undefined
  maxContextTokens: number | undefined
  items: readonly TranscriptItem[]
  /** 排队消息尚未进入时间线，仅存在 prompts 中。 */
  prompts: readonly TranscriptPrompt[]
  /** 审批展示与移除均由服务端待处理交互集合驱动。 */
  pendingInteractions: readonly TranscriptInteraction[]
  /** 初始标题取基线，后续由 session.meta.updated 更新。 */
  title: string
  /** loading 表示等待基线；读取失败或无法对齐时为 error。 */
  status: 'loading' | 'ready' | 'error'
  /** 是否存在更早的历史轮次。 */
  hasMoreOlder: boolean
  error?: string
}

const EMPTY_VIEW: TranscriptView = {
  activity: 'unknown',
  contextTokens: undefined,
  hasMoreOlder: false,
  items: [],
  maxContextTokens: undefined,
  pendingInteractions: [],
  prompts: [],
  status: 'loading',
  title: '',
}

type Absorbed = 'applied' | 'duplicate' | 'gap' | 'broken'

export class TranscriptReader {
  private transcript: AgentTranscript
  private readonly listeners = new Set<() => void>()

  /** 基线加载前缓冲，加载后按批次号应用。 */
  private buffered: TranscriptBatch[] = []

  /** 当前已应用批次号；尚无基线时为 null。 */
  private appliedSeq: number | null = null

  /** 串行执行 REST 读取，避免较旧响应覆盖较新基线。 */
  private queue: Promise<void> = Promise.resolve()

  private reloads = 0
  /** 合并尚未开始的基线加载，避免 StrictMode 或重复刷新产生并发请求。 */
  private reloadQueued = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private snapshot: TranscriptView = EMPTY_VIEW

  readonly conversationId: string
  /** main 是主流；子代理流的 id 是它的 run id，页与订阅都按它走。 */
  readonly agentId: string
  private readonly connection: TranscriptConnection
  private readonly grade: TranscriptGrade

  constructor(
    conversationId: string,
    connection: TranscriptConnection,
    grade: TranscriptGrade = 'delta',
    agentId: string = MAIN_AGENT_ID,
  ) {
    this.conversationId = conversationId
    this.agentId = agentId
    this.connection = connection
    this.grade = grade
    this.transcript = new AgentTranscript(agentId)
  }

  start(): void {
    // 允许 stop 后重新 start，兼容 StrictMode 的清理与重挂载。
    this.stopped = false
    this.connection.subscribe(
      this.conversationId,
      {
        onNotFound: () => this.fail(this.missingMessage()),
        onOps: (_agentId, ops, seq) => this.receive(ops, seq),
        onReset: () => {
          void this.reload()
        },
      },
      this.grade,
      this.agentId,
    )
    void this.reload()
  }

  /** 停下并清空手上的内容：没人看的流不占内存，再 start 时从基线重来。 */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.connection.unsubscribe(this.conversationId, this.agentId)
    this.transcript = new AgentTranscript(this.agentId)
    this.buffered = []
    this.appliedSeq = null
    this.reloads = 0
    if (this.snapshot !== EMPTY_VIEW) {
      this.snapshot = EMPTY_VIEW
      this.emit()
    }
  }

  private missingMessage(): string {
    return this.agentId === MAIN_AGENT_ID
      ? '这段对话不存在，或者不是你的'
      : '无法加载这个子代理的对话'
  }

  listen(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** 未变化时保留快照引用，供 React 外部存储订阅判断更新。 */
  view(): TranscriptView {
    return this.snapshot
  }

  refresh(): void {
    this.reloads = 0
    void this.reload()
  }

  private receive(ops: TranscriptOps, seq: number | undefined): boolean {
    if (seq === undefined) return false
    // 类型断言衔接 vendor 的可选字段与 zod 推导出的 undefined，见 transcript.api.ts。
    const batch = { ops: ops as TranscriptBatch['ops'], seq }
    if (this.appliedSeq === null) {
      // 基线加载前不应用批次，避免随后被基线覆盖。
      this.buffered.push(batch)
      return false
    }
    switch (this.absorb(batch)) {
      case 'applied':
      case 'duplicate':
        return true
      case 'gap':
        this.buffered.push(batch)
        this.catchup()
        return false
      case 'broken':
        this.scheduleReload()
        return false
    }
  }

  private absorb(batch: TranscriptBatch): Absorbed {
    const applied = this.appliedSeq
    if (applied === null) return 'gap'
    if (batch.seq <= applied) return 'duplicate'
    if (batch.seq > applied + 1) return 'gap'
    const result = this.transcript.apply(batch.ops)
    if (result.gap !== undefined) return 'broken'
    this.appliedSeq = batch.seq
    this.connection.markApplied(this.conversationId, this.agentId, batch.seq)
    this.publish()
    return 'applied'
  }

  /** 按序应用缓冲批次，遇到缺口时保留后续批次等待补发。 */
  private flush(): void {
    const pending = [...this.buffered].sort((left, right) => left.seq - right.seq)
    this.buffered = []
    for (const [index, batch] of pending.entries()) {
      const outcome = this.absorb(batch)
      if (outcome === 'applied' || outcome === 'duplicate') continue
      this.buffered.push(...pending.slice(index))
      if (outcome === 'gap') this.catchup()
      else this.scheduleReload()
      return
    }
  }

  private reload(): Promise<void> {
    if (this.reloadQueued) return this.queue
    this.reloadQueued = true
    this.queue = this.queue.then(async () => {
      this.reloadQueued = false
      if (this.stopped) return
      try {
        const baseline = await fetchTranscriptBaseline(this.conversationId, this.agentId)
        if (this.stopped) return
        this.transcript.apply([{ agentId: this.agentId, op: 'reset', snapshot: baseline.snapshot }])
        this.appliedSeq = baseline.seq
        this.connection.markApplied(this.conversationId, this.agentId, baseline.seq)
        this.reloads = 0
        this.snapshot = {
          activity: this.transcript.getMeta().activity ?? 'unknown',
          contextTokens: this.transcript.getMeta().agent?.contextTokens,
          hasMoreOlder: baseline.hasMoreOlder,
          items: this.transcript.getItems(),
          maxContextTokens: this.transcript.getMeta().agent?.maxContextTokens,
          pendingInteractions: this.pendingInteractions(),
          prompts: [...this.transcript.getPrompts().values()],
          status: 'ready',
          title: baseline.title,
        }
        this.emit()
        this.flush()
      } catch (error) {
        if (this.stopped) return
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          this.fail(this.missingMessage())
          return
        }
        this.fail(error instanceof Error ? error.message : '读取对话内容失败')
        this.scheduleReload()
      }
    })
    return this.queue
  }

  /** 请求缺失批次；超出日志窗口时重拉基线。 */
  private catchup(): void {
    this.queue = this.queue.then(async () => {
      const since = this.appliedSeq
      if (this.stopped || since === null) return
      try {
        const catchup = await fetchTranscriptCatchup(this.conversationId, since, this.agentId)
        if (this.stopped) return
        if (!catchup.complete) {
          this.scheduleReload()
          return
        }
        for (const batch of catchup.batches) this.buffered.push(batch)
        this.flush()
      } catch {
        this.scheduleReload()
      }
    })
  }

  private scheduleReload(): void {
    if (this.timer !== null || this.stopped) return
    if (this.reloads >= MAX_RELOADS) {
      this.fail('内容可能不全，点这里重新加载')
      return
    }
    this.reloads += 1
    this.timer = setTimeout(() => {
      this.timer = null
      void this.reload()
    }, reloadDelayMs(this.reloads))
  }

  private publish(): void {
    this.snapshot = {
      ...this.snapshot,
      activity: this.transcript.getMeta().activity ?? 'unknown',
      contextTokens: this.transcript.getMeta().agent?.contextTokens,
      items: this.transcript.getItems(),
      maxContextTokens: this.transcript.getMeta().agent?.maxContextTokens,
      pendingInteractions: this.pendingInteractions(),
      prompts: [...this.transcript.getPrompts().values()],
    }
    this.emit()
  }

  /** 将 store 中的待处理交互 ID 解析为界面所需实体。 */
  private pendingInteractions(): readonly TranscriptInteraction[] {
    return this.transcript
      .listPendingInteractions()
      .flatMap((id) => this.transcript.getInteraction(id) ?? [])
  }

  private fail(message: string): void {
    this.snapshot = { ...this.snapshot, error: message, status: 'error' }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
