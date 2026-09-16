/** 指标卡角上的迷你趋势线：只画形状，不画刻度；少于两个点不画，没数据的期断开而不是贴底。 */

import { Line, LineChart, ReferenceDot, XAxis, YAxis } from 'recharts'
import { cn } from '@/shared/lib/utils'

type SparklineProps = {
  values: readonly (number | null)[]
  className?: string
}

const SERIES = 'var(--color-chart-1)'
const WIDTH = 96
const HEIGHT = 28
const MARGIN = { top: 3, right: 3, bottom: 3, left: 3 }

export function Sparkline({ values, className }: SparklineProps) {
  if (values.filter((value) => value !== null).length < 2) return null
  const data = values.map((value, index) => ({ index, value }))
  const last = data.filter((point) => point.value !== null).at(-1)

  return (
    <span aria-hidden className={cn('block h-7 w-24 shrink-0', className)}>
      {/* 装饰性小图：关掉 Recharts 的无障碍层，不然 aria-hidden 里会多出一个能聚焦的 application。 */}
      <LineChart
        accessibilityLayer={false}
        data={data}
        height={HEIGHT}
        margin={MARGIN}
        width={WIDTH}
      >
        <XAxis dataKey="index" hide type="number" />
        <YAxis domain={['dataMin', 'dataMax']} hide />
        <Line
          activeDot={false}
          dataKey="value"
          dot={false}
          isAnimationActive={false}
          stroke={SERIES}
          strokeLinecap="round"
          strokeWidth={2}
          type="monotone"
        />
        {last === undefined || last.value === null ? null : (
          <ReferenceDot fill={SERIES} r={2.5} stroke="none" x={last.index} y={last.value} />
        )}
      </LineChart>
    </span>
  )
}
