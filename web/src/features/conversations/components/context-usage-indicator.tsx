import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

const RING_PATH = 100
const KILO = 1000
const MEGA = KILO * KILO

/** WorkBuddy formatTokenCount：千进位、一位小数去尾零。 */
const compact = (value: number): string => {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

const formatTokens = (tokens: number): string => {
  if (tokens >= MEGA) return `${compact(tokens / MEGA)}M`
  if (tokens >= KILO) return `${compact(tokens / KILO)}k`
  return String(tokens)
}

type ContextUsageIndicatorProps = {
  max: number
  used: number
}

/** 弧长低于这个数在 16px 的环上看不出来，整个环就像在转圈；画的时候垫到这里，数字照实报。 */
const MIN_ARC = 8

/** 用量过了这两条线，弧的颜色跟着变，不用看数字。 */
const WARN_AT = 80
const FULL_AT = 95

/** 上下文用量环；只展示后端 used/max，不在浏览器估算 token。 */
export function ContextUsageIndicator({ max, used }: ContextUsageIndicatorProps) {
  const percentValue = Math.min(100, Math.max(0, (used / max) * 100))
  const label = `${percentValue.toFixed(1)}% · ${formatTokens(used)} / ${formatTokens(max)} 上下文已使用`
  const arc = Math.max(MIN_ARC, percentValue)
  const arcColor =
    percentValue >= FULL_AT
      ? 'text-error'
      : percentValue >= WARN_AT
        ? 'text-warning'
        : 'text-primary'

  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className="flex size-8 shrink-0 cursor-default items-center justify-center rounded-full text-chat-muted-text ui-focus transition-colors ui-motion-s select-none hover:bg-hover"
          type="button"
        >
          <svg aria-hidden className="size-4" viewBox="0 0 20 20">
            <circle
              className="text-chat-hairline"
              cx="10"
              cy="10"
              fill="none"
              r="7.5"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle
              className={cn('transition-[stroke-dashoffset] ui-motion-m', arcColor)}
              cx="10"
              cy="10"
              fill="none"
              pathLength={RING_PATH}
              r="7.5"
              stroke="currentColor"
              strokeDasharray={RING_PATH}
              strokeDashoffset={RING_PATH - arc}
              strokeLinecap="round"
              strokeWidth="2"
              transform="rotate(-90 10 10)"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent className="whitespace-nowrap" side="top" sideOffset={8}>
        {label}
      </TooltipContent>
    </TooltipRoot>
  )
}
