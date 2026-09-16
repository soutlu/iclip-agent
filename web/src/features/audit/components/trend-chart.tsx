/** 单序列趋势图：柱或线，一条 y 轴、浅网格、按时段的 x 刻度，悬停出一格说明。

Recharts 画，颜色全走 token 变量，深浅主题跟着换；要换图表库时只动这一个组件。 */

import { useId } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts'

export type TrendPoint = {
  key: string
  /** x 轴刻度文字。 */
  label: string
  value: number | null
}

type TrendChartProps = {
  title: string
  points: readonly TrendPoint[]
  kind: 'bar' | 'line'
  /** 数值怎么写成字，刻度与悬停共用。 */
  format: (value: number) => string
  /** 画一条基准线（如每镜次数的 1.0）；越接近它越好。 */
  baseline?: number
  /** 比率一类的上限，让 y 轴顶在 1 而不是最大值。 */
  max?: number
  description?: string
}

const SERIES = 'var(--color-chart-1)'
const GRID = 'var(--color-border)'
const TICK = { fill: 'var(--color-on-surface-muted)', fontSize: 'var(--text-caption)' }
const MARGIN = { top: 8, right: 8, bottom: 0, left: 0 }
const DOT = {
  fill: SERIES,
  r: 3.5,
  stroke: 'var(--color-surface-container-lowest)',
  strokeWidth: 2,
}

export function TrendChart({
  title,
  points,
  kind,
  format,
  baseline,
  max,
  description,
}: TrendChartProps) {
  const titleId = useId()
  const domain: [number, number | 'auto'] = [0, max ?? 'auto']
  // 有上限的比率按四等分给刻度（0 / 25% / 50% / 75% / 100%），不让 Recharts 自己凑出 35%、70% 这种数。
  const tickProps =
    max === undefined ? { tickCount: 4 } : { ticks: [0, max / 4, max / 2, (max * 3) / 4, max] }
  const tooltip = (props: TooltipContentProps) => <TrendTooltip {...props} format={format} />
  const axes = (
    <>
      <CartesianGrid stroke={GRID} strokeDasharray="3 5" vertical={false} />
      <XAxis
        axisLine={false}
        dataKey="label"
        interval="preserveStartEnd"
        minTickGap={24}
        tick={TICK}
        tickLine={false}
        tickMargin={8}
      />
      <YAxis
        allowDecimals={max !== undefined}
        axisLine={false}
        domain={domain}
        tick={TICK}
        tickFormatter={format}
        tickLine={false}
        width="auto"
        {...tickProps}
      />
      {baseline === undefined ? null : (
        <ReferenceLine
          stroke="var(--color-on-surface-variant)"
          strokeDasharray="6 4"
          strokeWidth={1.5}
          y={baseline}
        />
      )}
    </>
  )

  return (
    <figure
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        <h3 className="text-title font-medium text-on-surface" id={titleId}>
          {title}
        </h3>
        {description === undefined ? null : (
          <span className="truncate text-body-sm text-on-surface-variant">{description}</span>
        )}
      </figcaption>
      {points.length === 0 ? (
        <p className="grid h-52 place-items-center text-body text-on-surface-variant">
          这个范围里没有数据
        </p>
      ) : kind === 'bar' ? (
        <BarChart
          className="h-52 w-full"
          data={points}
          margin={MARGIN}
          responsive
          title={`${title}趋势图`}
        >
          {axes}
          <Tooltip
            content={tooltip}
            cursor={{ fill: 'var(--color-state-hover)', radius: 4 }}
            isAnimationActive={false}
          />
          <Bar
            activeBar={{ fill: SERIES }}
            dataKey="value"
            fill={SERIES}
            isAnimationActive={false}
            maxBarSize={28}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      ) : (
        <LineChart
          className="h-52 w-full"
          data={points}
          margin={MARGIN}
          responsive
          title={`${title}趋势图`}
        >
          {axes}
          <Tooltip
            content={tooltip}
            cursor={{ stroke: GRID, strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <Line
            activeDot={{ ...DOT, r: 6 }}
            dataKey="value"
            dot={DOT}
            isAnimationActive={false}
            stroke={SERIES}
            strokeLinecap="round"
            strokeWidth={2}
            type="monotone"
          />
        </LineChart>
      )}
    </figure>
  )
}

type TrendTooltipProps = TooltipContentProps & { format: (value: number) => string }

/** 一格说明：时段 · 数值；Recharts 默认的白底框不跟主题，这里自己画。 */
function TrendTooltip({ active, payload, format }: TrendTooltipProps) {
  const point = payload[0]?.payload as TrendPoint | undefined
  if (!active || point === undefined) return null
  return (
    <div className="rounded-xs bg-inverse-surface px-2 py-1 text-label text-inverse-on-surface tabular-nums shadow-[var(--shadow-2)]">
      {point.label} · {point.value === null ? '无数据' : format(point.value)}
    </div>
  )
}
