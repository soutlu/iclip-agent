/** 趋势图：柱或线，一条 y 轴、浅网格、按时段的 x 刻度，悬停出一格说明；给了上一期就叠一条淡的对照序列。

Recharts 画，颜色全走 token 变量，深浅主题跟着换。 */

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
  /** 悬停里代替 label 的说法；刻度要短，悬停可以说全。 */
  tooltipLabel?: string
  value: number | null
}

type TrendChartProps = {
  title: string
  points: readonly TrendPoint[]
  kind: 'bar' | 'line'
  /** 数值怎么写成字，刻度与悬停共用。 */
  format: (value: number) => string
  /** 上一期同粒度的值，按下标对齐 points；长度不齐的位置当没数据。 */
  previous?: readonly (number | null)[] | undefined
  /** 画一条基准线（如每镜次数的 1.0）；越接近它越好。 */
  baseline?: number
  /** 比率一类的上限，让 y 轴顶在 1 而不是最大值。 */
  max?: number
  /** 线型：缺省平滑；累计分布一类的阶梯量用 step，值在这一档内保持不变。 */
  curve?: 'monotone' | 'step'
  /** 悬停时在数值下面补一行小字，如样本数；返回空就不加这一行。 */
  detail?: (point: TrendPoint) => string | undefined
  /** 没有数据时的一句话，缺省是按时段取数的说法。 */
  empty?: string
  description?: string
}

/** 图上的一行：本期的值加上一期对齐过来的值。 */
type TrendRow = TrendPoint & { previous: number | null }

const SERIES = 'var(--color-chart-1)'
const BEFORE = 'var(--color-chart-2)'
const GRID = 'var(--color-border)'
const TICK = { fill: 'var(--color-on-surface-muted)', fontSize: 'var(--text-caption)' }
const MARGIN = { top: 8, right: 8, bottom: 0, left: 0 }
const DASH = '5 4'
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
  previous,
  baseline,
  max,
  curve = 'monotone',
  detail,
  empty = '这个范围里没有数据',
  description,
}: TrendChartProps) {
  const titleId = useId()
  const withBefore = previous !== undefined
  const rows: TrendRow[] = points.map((point, index) => ({
    ...point,
    previous: previous?.[index] ?? null,
  }))
  const domain: [number, number | 'auto'] = [0, max ?? 'auto']
  // 有上限的比率按四等分给刻度（0 / 25% / 50% / 75% / 100%），不让 Recharts 自己凑出 35%、70% 这种数。
  const tickProps =
    max === undefined ? { tickCount: 4 } : { ticks: [0, max / 4, max / 2, (max * 3) / 4, max] }
  const lineType = curve === 'step' ? 'stepAfter' : 'monotone'
  const tooltip = (props: TooltipContentProps) => (
    <TrendTooltip {...props} detail={detail} format={format} withBefore={withBefore} />
  )
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
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-title font-medium text-on-surface" id={titleId}>
          {title}
        </h3>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 text-body-sm text-on-surface-variant">
          {description === undefined ? null : <span className="truncate">{description}</span>}
          {withBefore ? (
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-0.5 w-4 rounded-full"
                  style={{ background: SERIES }}
                />
                本期
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="w-4 border-t-2 border-dashed"
                  style={{ borderColor: BEFORE }}
                />
                上期
              </span>
            </span>
          ) : null}
        </span>
      </figcaption>
      {points.length === 0 ? (
        <p className="grid h-52 place-items-center text-body text-on-surface-variant">{empty}</p>
      ) : kind === 'bar' ? (
        <BarChart
          className="h-52 w-full"
          data={rows}
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
          {/* 上期柱在左、本期柱在右，按时间先后并排。 */}
          {withBefore ? (
            <Bar
              activeBar={false}
              dataKey="previous"
              fill="none"
              isAnimationActive={false}
              maxBarSize={28}
              radius={[4, 4, 0, 0]}
              stroke={BEFORE}
              strokeDasharray={DASH}
            />
          ) : null}
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
          data={rows}
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
          {withBefore ? (
            <Line
              activeDot={false}
              dataKey="previous"
              dot={false}
              isAnimationActive={false}
              stroke={BEFORE}
              strokeDasharray={DASH}
              strokeLinecap="round"
              strokeWidth={2}
              type={lineType}
            />
          ) : null}
          <Line
            activeDot={{ ...DOT, r: 6 }}
            dataKey="value"
            dot={DOT}
            isAnimationActive={false}
            stroke={SERIES}
            strokeLinecap="round"
            strokeWidth={2}
            type={lineType}
          />
        </LineChart>
      )}
    </figure>
  )
}

type TrendTooltipProps = TooltipContentProps & {
  format: (value: number) => string
  withBefore: boolean
  detail?: ((point: TrendPoint) => string | undefined) | undefined
}

/** 一格说明：时段加本期数值，有对照时再给一行上期；Recharts 默认的白底框不跟主题，这里自己画。 */
function TrendTooltip({ active, payload, format, withBefore, detail }: TrendTooltipProps) {
  const row = payload[0]?.payload as TrendRow | undefined
  if (!active || row === undefined) return null
  const read = (value: number | null) => (value === null ? '无数据' : format(value))
  const note = detail?.(row)
  const caption = row.tooltipLabel ?? row.label
  return (
    <div className="flex flex-col rounded-xs bg-inverse-surface px-2 py-1 text-label text-inverse-on-surface tabular-nums shadow-[var(--shadow-2)]">
      {withBefore ? (
        <>
          <span>{caption}</span>
          <span>本期 {read(row.value)}</span>
          <span>上期 {read(row.previous)}</span>
        </>
      ) : (
        <span>
          {caption} · {read(row.value)}
        </span>
      )}
      {note === undefined ? null : <span className="opacity-80">{note}</span>}
    </div>
  )
}
