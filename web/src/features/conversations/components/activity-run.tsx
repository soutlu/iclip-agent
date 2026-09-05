/** 参考 Kimi activity-run：活动组运行时自动展开，结束后自动收起。 */

import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { runHistoryMs, summarizeDone, summarizeRunning, type TurnEntry } from './activity-group'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { toolCard } from './tool-display'
import { TurnFrame } from './turn-frame'

type ActivityRunProps = {
  items: readonly TurnEntry[]
  liveFrameId: string | undefined
  settled: boolean
}

/** 运行时本地计时并在结束时冻结；历史记录使用步骤起止时间，缺失时不显示。 */
function useActivityMs(running: boolean, historyMs: number | undefined): number | undefined {
  const startedRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!running) return
    startedRef.current ??= Date.now()
    const started = startedRef.current
    const tick = () => setElapsed(Date.now() - started)
    // 立即记录初始读数，避免一秒内结束的活动没有计时结果。
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [running])

  if (running) return elapsed ?? 0
  return elapsed ?? historyMs
}

/** 当前图标优先取 liveFrameId，其次取运行中的工具。 */
const currentIcon = (items: readonly TurnEntry[], liveFrameId: string | undefined): IconName => {
  const current =
    items.find((entry) => entry.frame.frameId === liveFrameId) ??
    items.find((entry) => entry.frame.kind === 'tool' && entry.frame.state === 'running')
  if (current === undefined) return 'loading'
  if (current.frame.kind === 'thinking') return 'thinking'
  if (current.frame.kind === 'tool') return toolCard(current.frame.display).icon
  return 'loading'
}

const CLAUSE_TONE_CLASS = {
  danger: 'text-chat-status-error',
  faint: 'text-chat-muted-text',
} as const

export function ActivityRun({ items, liveFrameId, settled }: ActivityRunProps) {
  const running =
    !settled &&
    items.some(
      (entry) =>
        entry.frame.frameId === liveFrameId ||
        (entry.frame.kind === 'tool' && entry.frame.state === 'running'),
    )
  const failed = items.some((entry) => entry.frame.kind === 'tool' && entry.frame.state === 'error')

  // 用户手动切换后，自动开合不再覆盖其选择。
  const [open, setOpen] = useState(running)
  const [prevRunning, setPrevRunning] = useState(running)
  if (running !== prevRunning) {
    setPrevRunning(running)
    setOpen(running)
  }

  const elapsedMs = useActivityMs(running, runHistoryMs(items))
  const clauses = running
    ? summarizeRunning(items, liveFrameId, elapsedMs)
    : summarizeDone(items, elapsedMs)
  const stateLabel = running ? '进行中' : failed ? '有失败' : '完成'
  // 显式提供 aria-label，避免分色 span 的边界空白被可访问名称计算裁掉。
  const summaryText = clauses.map((clause) => clause.text).join(' · ')
  // 以内容和出现次数组成 key，区分相同的失败子句。
  const seen = new Map<string, number>()
  const keyed = clauses.map((clause) => {
    const base = `${clause.tone ?? ''}:${clause.text}`
    const nth = (seen.get(base) ?? 0) + 1
    seen.set(base, nth)
    return { clause, key: `${base}:${nth}` }
  })

  return (
    <div>
      <button
        aria-expanded={open}
        aria-label={`${stateLabel}：${summaryText}`}
        className="flex w-full cursor-pointer items-center gap-1 rounded-xs py-2 text-left text-body-sm text-chat-muted-text ui-focus ui-motion-s hover:text-chat-message-text"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Icon
          className={cn(
            'shrink-0',
            running && 'animate-pulse text-chat-muted-text',
            !running && (failed ? 'text-chat-status-error' : 'text-chat-status-success'),
          )}
          decorative
          name={running ? currentIcon(items, liveFrameId) : failed ? 'failed' : 'success'}
          size="sm"
        />
        <span aria-hidden className="min-w-0 truncate">
          {keyed.map(({ clause, key }, index) => (
            <span
              className={clause.tone === undefined ? undefined : CLAUSE_TONE_CLASS[clause.tone]}
              key={key}
            >
              {index === 0 ? clause.text : ` · ${clause.text}`}
            </span>
          ))}
        </span>
        <DisclosureChevron className="shrink-0 text-chat-muted-text" open={open} />
      </button>
      <DisclosureBody open={open}>
        <div className="flex flex-col gap-2 pt-1">
          {items.map((entry) => (
            <TurnFrame
              frame={entry.frame}
              key={entry.frame.frameId}
              live={entry.frame.frameId === liveFrameId}
              settled={settled}
            />
          ))}
        </div>
      </DisclosureBody>
    </div>
  )
}
