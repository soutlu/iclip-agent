/** 参考 WorkBuddy 终态栏；usage 与 endedAt 缺失时分别省略统计和时刻，悬停提示保留精确值。 */

import { useState } from 'react'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { CopyButton } from './copy-button'

/** ≥1000 缩成 x.xxk（两位小数去尾零），不足 1000 显整数。 */
const compactTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(2).replace(/\.?0+$/, '')}k`
}

const exactTokens = (tokens: number): string => tokens.toLocaleString('zh-CN')

const pad2 = (value: number): string => String(value).padStart(2, '0')

const isSameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/** 参考 WorkBuddy formatMessageTime：今天显示时分、昨天加前缀、更早显示月日，跨年补年份。 */
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

const TurnTime = ({ endedAt }: { endedAt: string }) => {
  // 相对日期以组件挂载时刻为参照。
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
  /** 复制使用原始 Markdown。 */
  copyText: string
  /** 缺失或无效的结束时间不显示。 */
  endedAt?: string | undefined
  /** 缺少 usage 时省略统计。 */
  usage?: TranscriptUsage | undefined
  /** 未提供回调时隐藏按钮；调用方负责末轮与空闲状态判断。 */
  onRegenerate?: (() => void) | undefined
  regenerateDisabled?: boolean | undefined
}

export function TurnActions({
  copyText,
  endedAt,
  onRegenerate,
  regenerateDisabled = false,
  usage,
}: TurnActionsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      <div className="flex items-center gap-2">
        <CopyButton text={copyText} />
        {onRegenerate === undefined ? null : (
          <IconButton
            className="text-chat-muted-text"
            disabled={regenerateDisabled}
            label="重新生成"
            name="refresh"
            onClick={onRegenerate}
            size="xs"
            title="重新生成"
            variant="standard"
          />
        )}
      </div>
      {usage === undefined ? null : <UsageStats usage={usage} />}
      {endedAt === undefined ? null : <TurnTime endedAt={endedAt} />}
    </div>
  )
}
