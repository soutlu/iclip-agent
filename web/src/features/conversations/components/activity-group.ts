/** 参考 Kimi activity-run：连续可折叠块至少两个且包含工具时成组；摘要按首次出现顺序聚合。 */

import type { TranscriptFrame, TranscriptStep } from '@/shared/transcript/vendor'
import { toolCard, toolMedia } from './tool-display'

export type TurnEntry = {
  frame: TranscriptFrame
  step: TranscriptStep
}

export type ActivityNode =
  { kind: 'entry'; entry: TurnEntry } | { kind: 'run'; runId: string; items: readonly TurnEntry[] }

/** 摘要的一条子句；tone 缺省是主文字色。 */
export type SummaryClause = {
  text: string
  tone?: 'danger' | 'faint'
}

/** 正文、通知与错误中断分组；包含媒体的工具保持独立，避免折叠后隐藏预览。 */
const foldable = (frame: TranscriptFrame) =>
  frame.kind === 'thinking' || (frame.kind === 'tool' && toolMedia(frame).length === 0)

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

/** 参考 Kimi 时长格式：20s、3m11s、1h2m；不足一秒不显示。 */
export const formatActivityDuration = (ms: number): string => {
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

/** 文件操作按操作类型聚合，其余工具按卡片文案聚合。 */
const bucketKey = (frame: ToolFrame): string => {
  const { label, operation } = toolCard(frame.display)
  if (operation !== undefined) return `op:${operation}`
  return label === '工具调用' ? 'other' : `summary:${label}`
}

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

const doingClause = (frame: TranscriptFrame): string => {
  if (frame.kind === 'thinking') return '思考中…'
  if (frame.kind !== 'tool') return ''
  const { detail, operation } = toolCard(frame.display)
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

/** 按首次出现顺序聚合，失败数附在所属类别后。 */
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

/** 完成态摘要附带可用的墙钟时长。 */
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

/** 运行态摘要先展示当前操作，再显示已完成类别和实时时长。 */
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

/** 步骤去重后，以最早开始和最晚结束计算墙钟时长；缺少时间戳时返回 undefined。 */
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
