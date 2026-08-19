import { useState } from 'react'
import type {
  AnalyticsDistributionItem,
  AnalyticsTrendPoint,
} from '@/features/analytics/api/generation-analytics'
import { formatDecimal, formatNumber } from './analytics-snapshot.utils'

export type TrendChartProps = {
  points: AnalyticsTrendPoint[]
}

export type TrendTooltipProps = {
  chartWidth: number
  left: number
  point: AnalyticsTrendPoint
}

export type TrendSeriesConfig = {
  color: string
  id: keyof Pick<
    AnalyticsTrendPoint,
    'avgRetry' | 'completedGenerations' | 'finalVideos' | 'firstPassVideos'
  >
  label: string
}

export type DistributionChartProps = {
  items: AnalyticsDistributionItem[]
  title: string
}

const TREND_SERIES: TrendSeriesConfig[] = [
  {
    color: 'var(--color-chart-1)',
    id: 'finalVideos',
    label: '成片',
  },
  {
    color: 'var(--color-chart-2)',
    id: 'completedGenerations',
    label: '视频条数',
  },
  {
    color: 'var(--color-chart-3)',
    id: 'avgRetry',
    label: '平均重试',
  },
  {
    color: 'var(--color-chart-4)',
    id: 'firstPassVideos',
    label: '首条成片',
  },
]

const TREND_CHART_HEIGHT = 244
const TREND_CHART_MIN_WIDTH = 760
const TREND_CHART_LEFT = 44
const TREND_CHART_RIGHT = 46
const TREND_CHART_TOP = 18
const TREND_CHART_BOTTOM = 34
const TREND_TOOLTIP_HALF_WIDTH = 78

/**
 * 渲染生成趋势多折线图。
 *
 * @param props - 趋势图属性。
 * @param props.points - 趋势数据点。
 * @returns 趋势图元素。
 */
export function TrendChart({ points }: TrendChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (points.length === 0) {
    return <p className="analytics-empty-text">暂无趋势数据</p>
  }

  const chartWidth = Math.max(
    TREND_CHART_MIN_WIDTH,
    TREND_CHART_LEFT + TREND_CHART_RIGHT + points.length * 26,
  )
  const plotWidth = chartWidth - TREND_CHART_LEFT - TREND_CHART_RIGHT
  const plotHeight = TREND_CHART_HEIGHT - TREND_CHART_TOP - TREND_CHART_BOTTOM
  const valueMax = Math.max(
    1,
    ...points.flatMap((point) => [
      point.finalVideos,
      point.completedGenerations,
      point.avgRetry,
      point.firstPassVideos,
    ]),
  )
  const gridTicks = [0, 0.25, 0.5, 0.75, 1]
  const showPointMarkers = points.length <= 31
  const columnWidth = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth
  const activePoint = activeIndex === null ? null : (points[activeIndex] ?? null)
  const activeX = activeIndex === null ? 0 : trendPointX(activeIndex, points.length, plotWidth)

  return (
    <div className="analytics-trend-shell">
      <ul className="analytics-trend-legend" aria-label="趋势图图例">
        {TREND_SERIES.map((series) => (
          <li key={series.id}>
            <span
              className="analytics-trend-legend-dot"
              style={{ backgroundColor: series.color }}
            />
            <span>{series.label}</span>
          </li>
        ))}
      </ul>
      <div className="analytics-trend-scroll">
        <div className="analytics-trend-plot" style={{ width: chartWidth }}>
          <svg
            aria-label="生成趋势：成片、视频条数、平均重试、首条成片"
            className="analytics-trend-svg"
            height={TREND_CHART_HEIGHT}
            role="img"
            viewBox={`0 0 ${chartWidth} ${TREND_CHART_HEIGHT}`}
            width={chartWidth}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <title>生成趋势：成片、视频条数、平均重试、首条成片</title>
            {gridTicks.map((tick) => {
              const y = TREND_CHART_TOP + (1 - tick) * plotHeight

              return (
                <g key={tick}>
                  <line
                    className="analytics-trend-grid-line"
                    x1={TREND_CHART_LEFT}
                    x2={chartWidth - TREND_CHART_RIGHT}
                    y1={y}
                    y2={y}
                  />
                  <text className="analytics-trend-axis-label" x={8} y={y + 4}>
                    {formatTrendAxisTick(valueMax * tick, valueMax)}
                  </text>
                </g>
              )
            })}
            {activePoint ? (
              <line
                className="analytics-trend-cursor"
                x1={activeX}
                x2={activeX}
                y1={TREND_CHART_TOP}
                y2={TREND_CHART_TOP + plotHeight}
              />
            ) : null}
            {TREND_SERIES.map((series) => (
              <path
                key={series.id}
                className="analytics-trend-line"
                d={createTrendLinePath(points, series, {
                  plotHeight,
                  plotWidth,
                  valueMax,
                })}
                fill="none"
                stroke={series.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
              />
            ))}
            {showPointMarkers
              ? TREND_SERIES.flatMap((series) =>
                  points.map((point, index) => (
                    <circle
                      key={`${series.id}-${point.id}`}
                      className="analytics-trend-point"
                      cx={trendPointX(index, points.length, plotWidth)}
                      cy={trendPointY(point[series.id], {
                        plotHeight,
                        valueMax,
                      })}
                      fill={series.color}
                      r="3.5"
                    />
                  )),
                )
              : null}
            {activePoint
              ? TREND_SERIES.map((series) => (
                  <circle
                    key={`active-${series.id}`}
                    className="analytics-trend-point analytics-trend-point--active"
                    cx={activeX}
                    cy={trendPointY(activePoint[series.id], {
                      plotHeight,
                      valueMax,
                    })}
                    fill={series.color}
                    r="4.5"
                  />
                ))
              : null}
            {points.map((point, index) =>
              shouldShowTrendLabel(index, points.length) ? (
                <text
                  key={point.id}
                  className="analytics-trend-x-label"
                  textAnchor="middle"
                  x={trendPointX(index, points.length, plotWidth)}
                  y={TREND_CHART_HEIGHT - 8}
                >
                  {point.label}
                </text>
              ) : null,
            )}
            {points.map((point, index) => (
              <rect
                key={`hit-${point.id}`}
                className="analytics-trend-hit"
                x={trendPointX(index, points.length, plotWidth) - columnWidth / 2}
                y={TREND_CHART_TOP}
                width={columnWidth}
                height={plotHeight}
                onMouseEnter={() => setActiveIndex(index)}
              />
            ))}
          </svg>
          {activePoint ? (
            <TrendTooltip point={activePoint} left={activeX} chartWidth={chartWidth} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * 趋势图悬停提示，展示某一天各指标的具体值。
 *
 * @param props - 组件属性。
 * @param props.point - 当前悬停的数据点。
 * @param props.left - 数据点在图内的水平像素位置。
 * @param props.chartWidth - 图表总宽度，用于约束提示框不溢出两侧。
 * @returns 提示框元素。
 */
function TrendTooltip({ point, left, chartWidth }: TrendTooltipProps) {
  const clampedLeft = Math.min(
    Math.max(left, TREND_TOOLTIP_HALF_WIDTH),
    chartWidth - TREND_TOOLTIP_HALF_WIDTH,
  )

  return (
    <div className="analytics-trend-tooltip" role="tooltip" style={{ left: clampedLeft }}>
      <p className="analytics-trend-tooltip-label">{point.label}</p>
      <dl>
        {TREND_SERIES.map((series) => (
          <div key={series.id}>
            <dt>
              <span
                className="analytics-trend-tooltip-dot"
                style={{ backgroundColor: series.color }}
              />
              {series.label}
            </dt>
            <dd>
              {series.id === 'avgRetry'
                ? formatDecimal(point[series.id])
                : formatNumber(point[series.id])}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * 生成趋势图单条折线路径。
 *
 * @param points - 趋势数据点。
 * @param series - 当前指标序列。
 * @param options - 绘图比例参数。
 * @returns SVG path d 属性。
 */
function createTrendLinePath(
  points: AnalyticsTrendPoint[],
  series: TrendSeriesConfig,
  options: {
    plotHeight: number
    plotWidth: number
    valueMax: number
  },
) {
  return points
    .map((point, index) => {
      const x = trendPointX(index, points.length, options.plotWidth)
      const y = trendPointY(point[series.id], options)
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

/**
 * 计算趋势图数据点 x 坐标。
 *
 * @param index - 数据点序号。
 * @param total - 数据点总数。
 * @param plotWidth - 绘图区宽度。
 * @returns SVG x 坐标。
 */
function trendPointX(index: number, total: number, plotWidth: number) {
  if (total <= 1) {
    return TREND_CHART_LEFT + plotWidth / 2
  }

  return TREND_CHART_LEFT + (index / (total - 1)) * plotWidth
}

/**
 * 计算趋势图数据点 y 坐标。
 *
 * @param value - 指标值。
 * @param options - 绘图比例参数。
 * @returns SVG y 坐标。
 */
function trendPointY(
  value: number,
  options: {
    plotHeight: number
    valueMax: number
  },
) {
  return TREND_CHART_TOP + (1 - value / Math.max(1, options.valueMax)) * options.plotHeight
}

/**
 * 控制趋势图横轴标签密度。
 *
 * @param index - 数据点序号。
 * @param total - 数据点总数。
 * @returns 当前点是否展示横轴标签。
 */
function shouldShowTrendLabel(index: number, total: number) {
  if (index === 0 || index === total - 1) {
    return true
  }

  if (total <= 14) {
    return true
  }

  const interval = total <= 31 ? 3 : 9
  return index % interval === 0
}

/**
 * 格式化趋势图统一数值轴刻度。
 *
 * @param value - 当前刻度值。
 * @param maxValue - 当前轴最大值。
 * @returns 坐标轴展示文案。
 */
function formatTrendAxisTick(value: number, maxValue: number) {
  if (maxValue <= 5 && !Number.isInteger(value)) {
    return formatDecimal(value)
  }

  return formatNumber(Math.round(value))
}

/**
 * 渲染横向分布图。
 *
 * @param props - 分布图属性。
 * @param props.items - 分布数据。
 * @param props.title - 图表标题，用于可访问标签。
 * @returns 分布图元素。
 */
export function DistributionChart({ items, title }: DistributionChartProps) {
  const maxCount = Math.max(1, ...items.map((item) => item.count))

  if (items.length === 0) {
    return <p className="analytics-empty-text">暂无分布数据</p>
  }

  return (
    <div className="analytics-distribution" role="img" aria-label={title}>
      {items.map((item) => (
        <div key={item.id} className="analytics-distribution-row">
          <span>{item.label}</span>
          <div className="analytics-distribution-track">
            <span
              className="analytics-distribution-bar"
              data-tone={item.tone}
              style={{
                width: `${item.count > 0 ? Math.max(8, Math.round((item.count / maxCount) * 100)) : 0}%`,
              }}
            />
          </div>
          <strong>{formatNumber(item.count)}</strong>
        </div>
      ))}
    </div>
  )
}
