import { Tooltip } from 'radix-ui'

const RING_PATH = 100
const KILO = 1024
const MEGA = KILO * KILO

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

/** Kimi 式上下文环：只展示后端给的 used/max，不在浏览器估算 token。 */
export function ContextUsageIndicator({ max, used }: ContextUsageIndicatorProps) {
  const percentage = Math.min(100, Math.max(0, Math.ceil((used / max) * 100)))
  const label = `使用 ${formatTokens(used)} / ${formatTokens(max)} tokens (${percentage}%)`

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            aria-label={label}
            className="flex shrink-0 cursor-default items-center rounded-xs py-0.5 ui-focus"
            type="button"
          >
            <svg aria-hidden className="size-4" viewBox="0 0 20 20">
              <circle
                className="text-chat-hairline"
                cx="10"
                cy="10"
                fill="none"
                r="7"
                stroke="currentColor"
                strokeWidth="2.5"
              />
              <circle
                className="text-primary transition-[stroke-dashoffset] ui-motion-m"
                cx="10"
                cy="10"
                fill="none"
                pathLength={RING_PATH}
                r="7"
                stroke="currentColor"
                strokeDasharray={RING_PATH}
                strokeDashoffset={RING_PATH - percentage}
                strokeLinecap="round"
                strokeWidth="2.5"
                transform="rotate(-90 10 10)"
              />
            </svg>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="layer-popup rounded-xs bg-inverse-surface px-2 py-1 text-label whitespace-nowrap text-inverse-on-surface shadow-[var(--shadow-2)] data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:fade-out data-[state=delayed-open]:animate-in data-[state=delayed-open]:duration-(--dur-m) data-[state=delayed-open]:ease-(--ease-decel) data-[state=delayed-open]:fade-in"
            side="top"
            sideOffset={8}
          >
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
