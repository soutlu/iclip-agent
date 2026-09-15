/** 单序列趋势图：柱或线，一条 y 轴、三根浅网格、按时段的 x 刻度，悬停出一格说明。

手写 SVG，不引图表库；要换库时只动这一个组件。 */

import { useId, useState } from 'react'
import { cn } from '@/shared/lib/utils'

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

const WIDTH = 640
const HEIGHT = 220
const MARGIN = { top: 16, right: 12, bottom: 28, left: 44 }
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom
const GRID_ROWS = 3

/** 让顶部刻度落在整数上：往上取到 1、2、5 × 10ⁿ 的整倍。 */
const niceCeil = (value: number): number => {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const unit = value / power
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10
  return step * power
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
  const [hovered, setHovered] = useState<number | null>(null)
  const titleId = useId()
  const values = points.map((point) => point.value ?? 0)
  const top = max ?? niceCeil(Math.max(...values, baseline ?? 0, 0))
  const slot = points.length === 0 ? PLOT_W : PLOT_W / points.length
  const y = (value: number) => MARGIN.top + PLOT_H - (Math.min(value, top) / top) * PLOT_H
  const xCenter = (index: number) => MARGIN.left + slot * index + slot / 2
  const barWidth = Math.max(4, Math.min(28, slot * 0.6))
  const labelEvery = Math.max(1, Math.ceil(points.length / 8))
  const linePath = points
    .map((point, index) =>
      point.value === null ? null : `${xCenter(index).toFixed(1)},${y(point.value).toFixed(1)}`,
    )
    .filter((part): part is string => part !== null)
    .join(' ')
  const hoveredPoint = hovered === null ? undefined : points[hovered]

  return (
    <figure
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        <h3 className="text-title font-medium text-on-surface" id={titleId}>
          {title}
        </h3>
        <span
          aria-live="polite"
          className="min-h-5 truncate text-body-sm text-on-surface-variant tabular-nums"
        >
          {hoveredPoint === undefined
            ? description
            : `${hoveredPoint.label} · ${hoveredPoint.value === null ? '无数据' : format(hoveredPoint.value)}`}
        </span>
      </figcaption>
      {points.length === 0 ? (
        <p className="grid h-40 place-items-center text-body text-on-surface-variant">
          这个范围里没有数据
        </p>
      ) : (
        <svg
          aria-label={`${title}趋势图`}
          className="block h-auto w-full"
          onMouseLeave={() => setHovered(null)}
          role="img"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        >
          {Array.from({ length: GRID_ROWS + 1 }, (_, row) => {
            const value = (top / GRID_ROWS) * row
            const gy = y(value)
            return (
              <g key={row}>
                <line
                  className="stroke-border/70"
                  strokeDasharray={row === 0 ? undefined : '3 5'}
                  strokeWidth={1}
                  x1={MARGIN.left}
                  x2={WIDTH - MARGIN.right}
                  y1={gy}
                  y2={gy}
                />
                <text
                  className="fill-on-surface-muted text-caption tabular-nums"
                  textAnchor="end"
                  x={MARGIN.left - 8}
                  y={gy + 4}
                >
                  {format(value)}
                </text>
              </g>
            )
          })}
          {baseline === undefined ? null : (
            <line
              className="stroke-on-surface-variant"
              strokeDasharray="6 4"
              strokeWidth={1.5}
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={y(baseline)}
              y2={y(baseline)}
            />
          )}
          {kind === 'line' && linePath.length > 0 ? (
            <polyline
              className="stroke-primary"
              fill="none"
              points={linePath}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            />
          ) : null}
          {points.map((point, index) => {
            const cx = xCenter(index)
            const active = hovered === index
            return (
              <g
                key={point.key}
                onMouseEnter={() => setHovered(index)}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(null)}
                tabIndex={-1}
              >
                <title>{`${point.label}：${point.value === null ? '无数据' : format(point.value)}`}</title>
                <rect
                  fill="transparent"
                  height={PLOT_H}
                  width={slot}
                  x={MARGIN.left + slot * index}
                  y={MARGIN.top}
                />
                {active ? (
                  <rect
                    className="fill-state-hover"
                    height={PLOT_H}
                    rx={4}
                    width={slot}
                    x={MARGIN.left + slot * index}
                    y={MARGIN.top}
                  />
                ) : null}
                {kind === 'bar' && point.value !== null ? (
                  <rect
                    className={cn(
                      'fill-primary ui-motion-s',
                      !active && hovered !== null && 'opacity-60',
                    )}
                    height={Math.max(0, MARGIN.top + PLOT_H - y(point.value))}
                    rx={4}
                    width={barWidth}
                    x={cx - barWidth / 2}
                    y={y(point.value)}
                  />
                ) : null}
                {kind === 'line' && point.value !== null ? (
                  <circle
                    className="fill-primary stroke-surface-container-lowest ui-motion-s"
                    cx={cx}
                    cy={y(point.value)}
                    r={active ? 6 : 3.5}
                    strokeWidth={2}
                  />
                ) : null}
                {index % labelEvery === 0 || index === points.length - 1 ? (
                  <text
                    className="fill-on-surface-muted text-caption tabular-nums"
                    textAnchor="middle"
                    x={cx}
                    y={HEIGHT - 8}
                  >
                    {point.label}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      )}
    </figure>
  )
}
