/**
 * 活动组（照 kimi 网页版的 activity-run）：一轮里连续的思考块与工具调用收成一行可折叠
 * 摘要——状态图标 + 聚合计数 + 时长，运行中自动展开、收尾自动收起；展开后每条就是普通的
 * 思考块 / 工具行。
 */

import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { runHistoryMs, summarizeDone, summarizeRunning, type TurnEntry } from './activity-group'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { toolCard } from './tool-display'
import { TurnFrame } from './turn-frame'

type ActivityRunProps = {
  items: readonly TurnEntry[]
  /** 整轮正在产出的那一块。 */
  liveFrameId: string | undefined
  /** 所在轮子是否已结束。 */
  settled: boolean
}

/**
 * 这一叠的墙钟：在跑就本地计时走秒，收尾冻结；历史一叠（没赶上直播）用成员步骤的起止
 * 时间算，缺时间戳就不显示。
 *
 * @param running - 这一叠是否还在跑。
 * @param historyMs - 历史时长（毫秒）。
 * @returns 毫秒；没有为 undefined。
 */
function useActivityMs(running: boolean, historyMs: number | undefined): number | undefined {
  const startedRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!running) return
    startedRef.current ??= Date.now()
    const started = startedRef.current
    const tick = () => setElapsed(Date.now() - started)
    // 先补一拍零帧：不到 1 秒就收尾的一叠，等第一拍早就把读数丢光了
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

/** 运行中头部图标的当前项：直播块优先，其次第一个在跑的工具。 */
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

/**
 * 渲染一叠活动。
 *
 * @param props - 组件属性。
 * @param props.items - 这一叠的块（连同步，给历史时长用）。
 * @param props.liveFrameId - 正在产出的那一块。
 * @param props.settled - 所在轮子是否已结束。
 * @returns 活动组。
 */
export function ActivityRun({ items, liveFrameId, settled }: ActivityRunProps) {
  const running =
    !settled &&
    items.some(
      (entry) =>
        entry.frame.frameId === liveFrameId ||
        (entry.frame.kind === 'tool' && entry.frame.state === 'running'),
    )
  const failed = items.some((entry) => entry.frame.kind === 'tool' && entry.frame.state === 'error')

  // 自动开合照 kimi：起跑自动展开，收尾自动收起；用户点过之后以最后一次操作为准
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
  // 可访问名走 aria-label：子句拆成多个 span 染色后，name-from-content 会在元素边界裁掉
  // 空白，拼出「完成读取了 1 个文件·写入了」这种没空格的串
  const summaryText = clauses.map((clause) => clause.text).join(' · ')
  // key 靠「内容 + 出现次数」去重（两个类别可能都欠出同一句「（1 失败）」），不用数组索引
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
