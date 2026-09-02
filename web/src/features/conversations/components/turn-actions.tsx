/**
 * 一轮回复尾部的终态栏：「复制 / 重新生成」图标钮、token 统计、完成时刻。
 *
 * 版式照 WorkBuddy 终态栏：24×24 透明图标钮（radius sm、icon-md、chat-muted-text，hover 铺
 * hover 状态底，150ms 过渡）常显；统计段由 credit 钻石图标领头，三项只留 k 缩略，精确值收进
 * 原生 title；完成时刻按「今天 HH:mm / 昨天 HH:mm / 更早 M月d日 HH:mm（跨自然年补年份）」缩写。
 * 统计与时刻默认透明、hover 该轮时一起浮现（WorkBuddy 同此：credit 与时刻都是 opacity 0 → hover 显现），
 * title 里各留精确值。统计只在这轮带 usage 时出现
 * （运行中、失败轮与旧数据没有它），时刻只在 endedAt 存在且能解析时出现。
 */

import { useState } from 'react'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { toast } from '@/shared/ui/toast'

const COPY_FEEDBACK_MS = 1400

/** 终态栏图标钮：复制与重新生成共用。禁用时压住 hover 那道状态底，只留灰。 */
const ACTION_BUTTON_CLASS =
  'inline-flex size-6 cursor-pointer items-center justify-center rounded-sm p-0 text-chat-muted-text ui-focus transition-colors ui-motion-s not-disabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40'

/** ≥1000 缩成 x.xxk（两位小数去尾零），不足 1000 显整数。 */
const compactTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(2).replace(/\.?0+$/, '')}k`
}

/** 悬停里的精确值：千分位整数。 */
const exactTokens = (tokens: number): string => tokens.toLocaleString('zh-CN')

const pad2 = (value: number): string => String(value).padStart(2, '0')

const isSameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/**
 * 栏内时刻照 WorkBuddy formatMessageTime：今天只显 HH:mm，昨天补「昨天」前缀，
 * 更早显 M月d日 HH:mm，跨自然年再补年份。解析不出来就当作没有。
 */
const messageTime = (iso: string, now: Date): string => {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const time = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`
  if (isSameDay(then, now)) return time
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(then, yesterday)) return `昨天 ${time}`
  const date = `${then.getMonth() + 1}月${then.getDate()}日`
  if (then.getFullYear() === now.getFullYear()) return `${date} ${time}`
  return `${then.getFullYear()}年${date} ${time}`
}

/** 悬停里的精确完整时刻：YYYY/MM/DD HH:mm:ss。调用前已确认 iso 能解析。 */
const fullTime = (iso: string): string => {
  const then = new Date(iso)
  return `${then.getFullYear()}/${pad2(then.getMonth() + 1)}/${pad2(then.getDate())} ${pad2(then.getHours())}:${pad2(then.getMinutes())}:${pad2(then.getSeconds())}`
}

/** 统计段：钻石图标领头，输入 / 缓存 / 输出三段中点分隔；默认透明、hover 该轮浮现；精确口径在 title 里。 */
const UsageStats = ({ usage }: { usage: TranscriptUsage }) => {
  const input = usage.inputTokens ?? 0
  const cached = usage.cachedTokens ?? 0
  const output = usage.outputTokens ?? 0
  return (
    <p
      className="flex items-center gap-1 text-caption text-chat-muted-text tabular-nums opacity-0 transition-opacity ui-motion-s group-hover:opacity-100"
      title={`输入 ${exactTokens(input)} · 缓存 ${exactTokens(cached)} · 输出 ${exactTokens(output)}`}
    >
      <Icon decorative name="credit" size="xs" />
      {`输入 ${compactTokens(input)} · 缓存 ${compactTokens(cached)} · 输出 ${compactTokens(output)}`}
    </p>
  )
}

/** 时刻段：默认透明，hover 该轮（article.group）时浮现；title 留精确完整时刻。 */
const TurnTime = ({ endedAt }: { endedAt: string }) => {
  // 「今天 / 昨天」的参照点取挂载时刻：一行时刻不需要随真实时间滚动
  const [now] = useState(() => new Date())
  const label = messageTime(endedAt, now)
  if (label === '') return null
  return (
    <time
      className="text-caption text-chat-muted-text tabular-nums opacity-0 transition-opacity ui-motion-s group-hover:opacity-100"
      dateTime={endedAt}
      title={fullTime(endedAt)}
    >
      {label}
    </time>
  )
}

type TurnActionsProps = {
  /** 这轮回复的原始 markdown（复制内容）。 */
  copyText: string
  /** 这轮结束时刻；渲染栏尾时刻段，缺失或解析不出则时刻段不渲染。 */
  endedAt?: string | undefined
  /** 这轮 token 统计；整体缺失（运行中 / 失败 / 旧数据）时统计段不渲染。 */
  usage?: TranscriptUsage | undefined
  /** 重新生成这一轮；不传则不渲染该按钮（调用方判定是否最后一轮、对话是否空闲）。 */
  onRegenerate?: (() => void) | undefined
  regenerateDisabled?: boolean | undefined
}

/**
 * 渲染终态栏。
 *
 * @param props - 组件属性。
 * @param props.copyText - 复制内容。
 * @param props.endedAt - 这轮结束时刻。
 * @param props.usage - 这轮 token 统计。
 * @param props.onRegenerate - 重新生成回调。
 * @param props.regenerateDisabled - 重新生成暂不可用。
 * @returns 终态栏。
 */
export function TurnActions({
  copyText,
  endedAt,
  onRegenerate,
  regenerateDisabled = false,
  usage,
}: TurnActionsProps) {
  const [copied, setCopied] = useState(false)

  const copyReply = async () => {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      <div className="flex items-center gap-2">
        <button
          aria-label="复制"
          className={ACTION_BUTTON_CLASS}
          onClick={() => void copyReply()}
          title={copied ? '已复制' : '复制'}
          type="button"
        >
          <Icon decorative name={copied ? 'check' : 'copy'} size="md" />
        </button>
        {onRegenerate === undefined ? null : (
          <button
            aria-label="重新生成"
            className={ACTION_BUTTON_CLASS}
            disabled={regenerateDisabled}
            onClick={onRegenerate}
            title="重新生成"
            type="button"
          >
            <Icon decorative name="refresh" size="md" />
          </button>
        )}
      </div>
      {usage === undefined ? null : <UsageStats usage={usage} />}
      {endedAt === undefined ? null : <TurnTime endedAt={endedAt} />}
    </div>
  )
}
