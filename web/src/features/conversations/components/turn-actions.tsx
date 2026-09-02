/**
 * 一轮回复尾部的操作行：左边「复制 / 重新生成」两个幽灵钮，右边这轮烧掉的 token 统计。
 *
 * 按钮沿用 05 · CHAT 里助手回复操作的语义：icon-sm、muted 70%，hover 提亮并铺 hover 状态底；
 * 复制成功换 check 1.4s。统计只在这轮带 usage 时出现（运行中、失败轮与旧数据没有它），
 * 行内只留 k 缩略，精确值与完成时刻收进原生 title，不抢正文。
 */

import { useState } from 'react'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { toast } from '@/shared/ui/toast'

const COPY_FEEDBACK_MS = 1400

/** 幽灵图标钮：复制与重新生成共用。禁用时压住 hover 那套提亮，只留灰。 */
const ACTION_BUTTON_CLASS =
  'inline-flex min-h-[22px] cursor-pointer items-center justify-center rounded-sm px-[5px] py-0.5 text-chat-muted-text opacity-70 ui-focus transition-[opacity,color,background-color] ui-motion-s not-disabled:hover:bg-hover not-disabled:hover:text-primary not-disabled:hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40'

/** ≥1000 缩成 x.xxk（两位小数去尾零），不足 1000 显整数。 */
const compactTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(2).replace(/\.?0+$/, '')}k`
}

/** 悬停里的精确值：千分位整数。 */
const exactTokens = (tokens: number): string => tokens.toLocaleString('zh-CN')

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 完成时刻：当天只显时分秒，跨天补上日期。解析不出来就当作没有。 */
const finishedAt = (iso: string, now: Date): string => {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const time = `${pad2(then.getHours())}:${pad2(then.getMinutes())}:${pad2(then.getSeconds())}`
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  if (sameDay) return time
  return `${then.getFullYear()}/${pad2(then.getMonth() + 1)}/${pad2(then.getDate())} ${time}`
}

type UsageStatsProps = {
  usage: TranscriptUsage
  endedAt?: string | undefined
}

/** 右侧统计段：输入 / 缓存 / 输出三段，中点分隔；精确口径与完成时刻在 title 里。 */
const UsageStats = ({ endedAt, usage }: UsageStatsProps) => {
  // 「当天」的参照点取挂载时刻：一行统计不需要随真实时间滚动
  const [now] = useState(() => new Date())
  const input = usage.inputTokens ?? 0
  const cached = usage.cachedTokens ?? 0
  const output = usage.outputTokens ?? 0
  const exact = `输入 ${exactTokens(input)} · 缓存 ${exactTokens(cached)} · 输出 ${exactTokens(output)}`
  const finished = endedAt === undefined ? '' : finishedAt(endedAt, now)
  return (
    <p
      className="text-caption text-chat-muted-text tabular-nums"
      title={finished === '' ? exact : `${exact}\n完成于 ${finished}`}
    >
      {`输入 ${compactTokens(input)} · 缓存 ${compactTokens(cached)} · 输出 ${compactTokens(output)}`}
    </p>
  )
}

type TurnActionsProps = {
  /** 这轮回复的原始 markdown（复制内容）。 */
  copyText: string
  /** 这轮结束时刻；给统计段的 title 用，缺失则 title 只有精确值那行。 */
  endedAt?: string | undefined
  /** 这轮 token 统计；整体缺失（运行中 / 失败 / 旧数据）时统计段不渲染。 */
  usage?: TranscriptUsage | undefined
  /** 重新生成这一轮；不传则不渲染该按钮（调用方判定是否最后一轮、对话是否空闲）。 */
  onRegenerate?: (() => void) | undefined
  regenerateDisabled?: boolean | undefined
}

/**
 * 渲染操作行。
 *
 * @param props - 组件属性。
 * @param props.copyText - 复制内容。
 * @param props.endedAt - 这轮结束时刻。
 * @param props.usage - 这轮 token 统计。
 * @param props.onRegenerate - 重新生成回调。
 * @param props.regenerateDisabled - 重新生成暂不可用。
 * @returns 操作行。
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
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-0.5">
        <button
          aria-label="复制"
          className={ACTION_BUTTON_CLASS}
          onClick={() => void copyReply()}
          title={copied ? '已复制' : '复制'}
          type="button"
        >
          <Icon decorative name={copied ? 'check' : 'copy'} size="sm" />
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
            <Icon decorative name="refresh" size="sm" />
          </button>
        )}
      </div>
      {usage === undefined ? null : <UsageStats endedAt={endedAt} usage={usage} />}
    </div>
  )
}
