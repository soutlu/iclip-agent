/**
 * 活动组（照 kimi 网页版的 activity-run）：一轮里连续的思考块与工具调用攒成一行可折叠摘要。
 *
 * 规则照它：连续可折叠块 ≥ 2 且含工具才成组（单块原样单列）；摘要按操作类别聚合计数、
 * 保持首次出现顺序，失败追加危险色子句，尾巴挂时长。
 */

import type { TranscriptFrame, TranscriptStep } from '@/shared/transcript/vendor'
import { toolCard, toolOperation } from './tool-display'

/** 时间线上的一块连同它所在的那步。 */
export type TurnEntry = {
  frame: TranscriptFrame
  step: TranscriptStep
}

/** 分组后的渲染节点：要么单独一块，要么一叠。 */
export type ActivityNode =
  { kind: 'entry'; entry: TurnEntry } | { kind: 'run'; runId: string; items: readonly TurnEntry[] }

/** 摘要的一条子句；tone 缺省是主文字色。 */
export type SummaryClause = {
  text: string
  tone?: 'danger' | 'faint'
}

/** 思考块与工具调用可折叠；正文、通知、报错打断一叠。 */
const foldable = (frame: TranscriptFrame) => frame.kind === 'thinking' || frame.kind === 'tool'

/**
 * 把一轮的块折成渲染节点。
 *
 * @param entries - 这一轮按顺序的块。
 * @returns 渲染节点序列。
 */
export const groupTurnEntries = (entries: readonly TurnEntry[]): ActivityNode[] => {
  const out: ActivityNode[] = []
  let buffer: TurnEntry[] = []

  const flush = () => {
    if (buffer.length >= 2 && buffer.some((entry) => entry.frame.kind === 'tool')) {
      out.push({ items: buffer, kind: 'run', runId: `${buffer[0]?.frame.frameId}.run` })
    } else {
      for (const entry of buffer) out.push({ entry, kind: 'entry' })
    }
    buffer = []
  }

  for (const entry of entries) {
    if (foldable(entry.frame)) {
      buffer.push(entry)
    } else {
      flush()
      out.push({ entry, kind: 'entry' })
    }
  }
  flush()
  return out
}

/** 时长格式照 kimi：20s、3m11s、1h2m；0 与负数不出字。 */
export const formatActivityDuration = (ms: number): string => {
  // 不足一秒不显示：四舍五入出来的「0s」是噪音不是信息
  if (ms < 1000) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m${restSeconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
}

type ToolFrame = Extract<TranscriptFrame, { kind: 'tool' }>

/** 工具的聚合桶：文件操作按操作分，其余按卡片文案分；认不出的落「其他」。 */
const bucketKey = (frame: ToolFrame): string => {
  const operation = toolOperation(frame.display)
  if (operation !== undefined) return `op:${operation}`
  const { label } = toolCard(frame.display)
  return label === '工具调用' ? 'other' : `summary:${label}`
}

/** 完成态一类的一句：读取了 2 个文件 / 出镜头帧 ×3 / 执行了 2 次操作。 */
const doneClause = (key: string, count: number, live: boolean): string => {
  const prefix = live ? '已' : ''
  if (key.startsWith('op:')) {
    const operation = key.slice(3) as keyof typeof OPERATION_LABELS
    return `${prefix}${OPERATION_LABELS[operation](count)}`
  }
  if (key === 'other') return `${prefix}执行了 ${count} 次操作`
  return `${prefix}${key.slice(8)} ×${count}`
}

const OPERATION_LABELS = {
  read: (n: number) => `读取了 ${n} 个文件`,
  write: (n: number) => `写入了 ${n} 个文件`,
  edit: (n: number) => `编辑了 ${n} 处`,
  glob: (n: number) => `列出了 ${n} 个目录`,
  grep: (n: number) => `搜索了 ${n} 个模式`,
} as const

/** 运行中的当前项一句：正在读取 shots/… / 思考中…。 */
const doingClause = (frame: TranscriptFrame): string => {
  if (frame.kind === 'thinking') return '思考中…'
  if (frame.kind !== 'tool') return ''
  const operation = toolOperation(frame.display)
  const { detail } = toolCard(frame.display)
  const subject = detail === undefined ? '' : ` ${detail}`
  if (operation === undefined) return '正在执行…'
  return `${DOING_VERB[operation]}${subject}`
}

/** 运行中的当前项动词（照 kimi 的 tools.activity.doing.*）。 */
const DOING_VERB = {
  read: '正在读取',
  write: '正在写入',
  edit: '正在编辑',
  glob: '正在列出',
  grep: '正在搜索',
} as const

/** 把一叠按桶聚成子句序列：类别保持首次出现顺序，失败数缀在所属类别后面。 */
const aggregate = (tools: readonly ToolFrame[], live: boolean): SummaryClause[] => {
  const buckets = new Map<string, { count: number; errors: number }>()
  for (const frame of tools) {
    const key = bucketKey(frame)
    const bucket = buckets.get(key) ?? { count: 0, errors: 0 }
    bucket.count += 1
    if (frame.state === 'error') bucket.errors += 1
    buckets.set(key, bucket)
  }
  const clauses: SummaryClause[] = []
  for (const [key, bucket] of buckets) {
    clauses.push({ text: doneClause(key, bucket.count, live) })
    if (bucket.errors > 0) clauses.push({ text: `（${bucket.errors} 失败）`, tone: 'danger' })
  }
  return clauses
}

/**
 * 完成态摘要：「搜索了 1 个模式 · 写入了 1 个文件 · 3m11s」。
 *
 * @param items - 这一叠。
 * @param durationMs - 这一叠的墙钟时长；没有就不挂。
 * @returns 子句序列。
 */
export const summarizeDone = (
  items: readonly TurnEntry[],
  durationMs: number | undefined,
): SummaryClause[] => {
  const tools = items.flatMap((entry) => (entry.frame.kind === 'tool' ? [entry.frame] : []))
  const clauses = aggregate(tools, false)
  const duration = durationMs === undefined ? '' : formatActivityDuration(durationMs)
  if (duration !== '') clauses.push({ text: duration, tone: 'faint' })
  return clauses
}

/**
 * 运行中摘要：「正在读取 shots/storyboard.md · 已搜索了 1 个模式 · 20s」。当前子句当头，
 * 已完成的类别弱化带「已」前缀，时长实时走。
 *
 * @param items - 这一叠。
 * @param liveFrameId - 正在产出的那一块。
 * @param elapsedMs - 已经跑了多久。
 * @returns 子句序列。
 */
export const summarizeRunning = (
  items: readonly TurnEntry[],
  liveFrameId: string | undefined,
  elapsedMs: number | undefined,
): SummaryClause[] => {
  const current =
    items.find((entry) => entry.frame.frameId === liveFrameId) ??
    items.find((entry) => entry.frame.kind === 'tool' && entry.frame.state === 'running') ??
    items.at(-1)
  const done = items.flatMap((entry) =>
    entry.frame.kind === 'tool' &&
    entry.frame.frameId !== current?.frame.frameId &&
    entry.frame.state !== 'running'
      ? [entry.frame]
      : [],
  )
  const clauses: SummaryClause[] = []
  if (current !== undefined) {
    const text = doingClause(current.frame)
    if (text !== '') clauses.push({ text })
  }
  clauses.push(...aggregate(done, true).map((clause) => ({ ...clause, tone: 'faint' as const })))
  const elapsed = elapsedMs === undefined ? '' : formatActivityDuration(elapsedMs)
  if (elapsed !== '') clauses.push({ text: elapsed, tone: 'faint' })
  return clauses
}

/**
 * 历史一叠的墙钟时长：成员步骤去重后取最早开始与最晚结束。缺时间戳就不给。
 *
 * @param items - 这一叠。
 * @returns 毫秒；算不出为 undefined。
 */
export const runHistoryMs = (items: readonly TurnEntry[]): number | undefined => {
  const steps = new Map<string, TranscriptStep>()
  for (const { step } of items) steps.set(step.stepId, step)
  let start: number | undefined
  let end: number | undefined
  for (const step of steps.values()) {
    if (step.startedAt !== undefined) {
      const at = Date.parse(step.startedAt)
      if (!Number.isNaN(at)) start = start === undefined ? at : Math.min(start, at)
    }
    if (step.endedAt !== undefined) {
      const at = Date.parse(step.endedAt)
      if (!Number.isNaN(at)) end = end === undefined ? at : Math.max(end, at)
    }
  }
  if (start === undefined || end === undefined || end < start) return undefined
  return end - start
}
