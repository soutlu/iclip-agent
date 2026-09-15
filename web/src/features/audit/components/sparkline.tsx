/** 指标卡角上的迷你趋势线：只画形状，不画刻度；少于两个点不画。 */

import { cn } from '@/shared/lib/utils'

type SparklineProps = {
  values: readonly number[]
  className?: string
}

const WIDTH = 96
const HEIGHT = 28
const PAD = 2

export function Sparkline({ values, className }: SparklineProps) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const step = (WIDTH - PAD * 2) / (values.length - 1)
  const points = values.map((value, index) => {
    const x = PAD + index * step
    const y = HEIGHT - PAD - ((value - min) / span) * (HEIGHT - PAD * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const last = points.at(-1)?.split(',') ?? []

  return (
    <svg
      aria-hidden
      className={cn('block h-7 w-24 shrink-0 text-primary', className)}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    >
      <polyline
        fill="none"
        points={points.join(' ')}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <circle cx={last[0]} cy={last[1]} fill="currentColor" r={2.5} />
    </svg>
  )
}
