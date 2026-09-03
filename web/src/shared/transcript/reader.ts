/**
 * 一段对话的读取端：把 REST 基线与 WS 批次合成一份能渲染的时间线。
 *
 * 形状照 kimi 出厂客户端：订阅与拉基线同时开始，基线落地之前到达的批次先进缓冲区，落地之后
 * 按批次号一次性叠上。补漏分三档，越轻的先来——跳号只要缺的那几批；服务端说批次已经出了窗口
 * 就整页重拉；落地时报出内容缺口才全量刷新，最多三轮。
 *
 * **没吃下的批次一律返回 `false`**：连接那一层据此不推进水位，重连时它还会被带回来。返回
 * `true` 而没落地的话，那一批就此消失，界面从此少一段且不报错。
 */

import { ApiError } from '@/shared/api/client'
import type { TranscriptConnection, TranscriptGrade, TranscriptOps } from './connection'
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

/** 我们只有主 agent。 */
const MAIN_AGENT = 'main'

/** 全量刷新最多来几轮。再多就是服务端与客户端对不上，退给界面让人点重试。 */
const MAX_RELOADS = 3

/** 重拉的退避：第 n 次等 n×2 秒，上限 15 秒。照 kimi。 */
const reloadDelayMs = (attempt: number) => Math.min(attempt * 2000, 15_000)

export interface TranscriptView {
  /** 运行态直接来自 transcript meta；对话页据此判断当前是否仍在一轮里。 */
  activity: ActivityMeta
  /** Kimi 的上下文状态：后端给原始 used/max，前端只负责展示。 */
  contextTokens: number | undefined
  maxContextTokens: number | undefined
  /** 时间线：一串轮子，各自带步与块。 */
  items: readonly TranscriptItem[]
  /** 服务端记下的用户消息。排队中的那几条只在这里，时间线上还没有它们。 */
  prompts: readonly TranscriptPrompt[]
  /** 还在等人回应的交互。审批卡按它出现，回应落库后由推送把它撤掉。 */
  pendingInteractions: readonly TranscriptInteraction[]
  /** 这段对话叫什么。基线给的那个；之后被改名会由 `session.meta.updated` 盖过去。 */
  title: string
  /** `loading` 是基线还没到；`error` 是拉不到或者对不齐，界面给重试入口。 */
  status: 'loading' | 'ready' | 'error'
  /** 上面还有更早的轮子（往上翻页在 PR 之后做）。 */
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

/** 一批操作的落地结果。 */
type Absorbed = 'applied' | 'duplicate' | 'gap' | 'broken'

export class TranscriptReader {
  private readonly transcript = new AgentTranscript(MAIN_AGENT)
  private readonly listeners = new Set<() => void>()

  /** 基线还没落地时到达的批次。落地之后按批次号叠上。 */
  private buffered: TranscriptBatch[] = []

  /** 手上这份内容对应的批次号。基线还没到时是 null。 */
  private appliedSeq: number | null = null

  /** REST 读串行排队：两份基线同时在飞的话，后到的那份可能是更旧的一页。 */
  private queue: Promise<void> = Promise.resolve()

  private reloads = 0
  /** 队里已经排着一次还没开跑的拉基线。排着就不再排：严格模式的两次挂载、连点两次刷新，都只该发一次请求。 */
  private reloadQueued = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private snapshot: TranscriptView = EMPTY_VIEW

  private readonly conversationId: string
  private readonly connection: TranscriptConnection
  private readonly grade: TranscriptGrade

  constructor(
    conversationId: string,
    connection: TranscriptConnection,
    grade: TranscriptGrade = 'delta',
  ) {
    this.conversationId = conversationId
    this.connection = connection
    this.grade = grade
  }

  /** 订阅并拉基线。两件事同时开始，收敛不靠先后。 */
  start(): void {
    // 停过之后再 start 是重新开始：不清掉这个标记，拉基线会当场返回，界面永远停在 loading
    // （React 严格模式下挂载效果会先跑一遍清理，正是这个次序）。
    this.stopped = false
    this.connection.subscribe(
      this.conversationId,
      {
        onNotFound: () => this.fail('这段对话不存在，或者不是你的'),
        onOps: (_agentId, ops, seq) => this.receive(ops, seq),
        onReset: () => {
          void this.reload()
        },
      },
      this.grade,
    )
    void this.reload()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.connection.unsubscribe(this.conversationId)
  }

  /** 供 React 订阅。返回退订函数。 */
  listen(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** 当前这份内容。同一份内容返回同一个对象，React 据此判要不要重渲。 */
  view(): TranscriptView {
    return this.snapshot
  }

  /** 界面上的「重新加载」。 */
  refresh(): void {
    this.reloads = 0
    void this.reload()
  }

  // --- 收批次 ---------------------------------------------------------------

  private receive(ops: TranscriptOps, seq: number | undefined): boolean {
    if (seq === undefined) return false
    // 这个 `as` 是 vendor 那两格宽松在类型上的接缝（见 `transcript.api.ts` 的说明）：帧里校验
    // 出来的与 reducer 声明的是同一件事，只差 `| undefined`。
    const batch = { ops: ops as TranscriptBatch['ops'], seq }
    if (this.appliedSeq === null) {
      // 基线还在飞。先攒着：这时候落地的话，随后那份基线会把它整个盖掉。
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

  /** 按批次号把一批叠上去。落地与否由返回值说。 */
  private absorb(batch: TranscriptBatch): Absorbed {
    const applied = this.appliedSeq
    if (applied === null) return 'gap'
    if (batch.seq <= applied) return 'duplicate'
    if (batch.seq > applied + 1) return 'gap'
    const result = this.transcript.apply(batch.ops)
    if (result.gap !== undefined) return 'broken'
    this.appliedSeq = batch.seq
    this.connection.markApplied(this.conversationId, MAIN_AGENT, batch.seq)
    this.publish()
    return 'applied'
  }

  /** 把攒着的批次按号叠上。中间断档就停下，剩下的留在缓冲区里等补批。 */
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

  // --- 拉内容 ---------------------------------------------------------------

  /** 拉一页当基线。REST 读排在同一条队里，按调用次序执行。 */
  private reload(): Promise<void> {
    if (this.reloadQueued) return this.queue
    this.reloadQueued = true
    this.queue = this.queue.then(async () => {
      this.reloadQueued = false
      if (this.stopped) return
      try {
        const baseline = await fetchTranscriptBaseline(this.conversationId)
        if (this.stopped) return
        this.transcript.apply([{ agentId: MAIN_AGENT, op: 'reset', snapshot: baseline.snapshot }])
        this.appliedSeq = baseline.seq
        this.connection.markApplied(this.conversationId, MAIN_AGENT, baseline.seq)
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
          this.fail('这段对话不存在，或者不是你的')
          return
        }
        this.fail(error instanceof Error ? error.message : '读取对话内容失败')
        this.scheduleReload()
      }
    })
    return this.queue
  }

  /** 只要缺的那几批。服务端说要不回来就整页重拉。 */
  private catchup(): void {
    this.queue = this.queue.then(async () => {
      const since = this.appliedSeq
      if (this.stopped || since === null) return
      try {
        const catchup = await fetchTranscriptCatchup(this.conversationId, since)
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

  /** 退一步全量重拉，最多三轮。到顶了就退给界面。 */
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

  // --- 出快照 ---------------------------------------------------------------

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

  /** 待回应的交互实体：store 只记 id，界面要的是实体。 */
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
