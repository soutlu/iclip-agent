/** 集中度图（洛伦兹曲线）：镜按出片次数从少到多排队，看前 x% 的镜吃掉了多少次数。
 *
 * 只有几个点、没有时间轴，用不上 TrendChart 那套；这里手写 SVG，颜色同样走 token。 */

import { useId } from 'react'
import { EMPTY, formatRate } from '../format'
import type { LorenzPoint } from '../attempt-distribution'

type ConcentrationChartProps = {
  title: string
  points: readonly LorenzPoint[]
  /** 集中度（基尼系数）：0 是每个镜花的次数一样，越大越集中在个别镜。 */
  concentration: number | null
  /** 上一期的集中度，只作对照；没有上一期是 null。 */
  before: number | null
}

const SIZE = 240
const PAD = 18
const SERIES = 'var(--color-chart-1)'
const GRID = 'var(--color-border)'
const LABEL = 'var(--color-on-surface-muted)'

const px = (share: number) => PAD + share * SIZE
const py = (share: number) => PAD + SIZE - share * SIZE

export function ConcentrationChart({
  title,
  points,
  concentration,
  before,
}: ConcentrationChartProps) {
  const titleId = useId()
  const path = points.map((point) => `${px(point.shotShare)},${py(point.attemptShare)}`).join(' L ')
  // 最后一个点必然是 (100%, 100%)，列出来没有信息量。
  const rows = points.slice(1, -1)
  // 队尾那一档：出片次数最多的那批镜占多少、吃掉多少次数，就是这张图要说的一句话。
  const tail = rows.at(-1)

  return (
    <figure
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
    >
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-title font-medium text-on-surface" id={titleId}>
          {title}
        </h3>
        <span className="min-w-0 truncate text-body-sm text-on-surface-variant">
          镜按出片次数从少到多排队
        </span>
      </figcaption>
      {points.length === 0 ? (
        <p className="grid h-52 place-items-center text-body text-on-surface-variant">
          这个范围里没有数据
        </p>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <svg
            aria-label={`${title}：对角线表示每个镜花的次数一样，曲线越往下坠越集中`}
            className="h-52 w-full shrink-0 sm:w-52"
            role="img"
            viewBox={`0 0 ${SIZE + PAD * 2} ${SIZE + PAD * 2}`}
          >
            <rect
              fill="none"
              height={SIZE}
              stroke={GRID}
              strokeWidth={1}
              width={SIZE}
              x={px(0)}
              y={py(1)}
            />
            <line
              stroke={GRID}
              strokeDasharray="5 4"
              strokeWidth={1.5}
              x1={px(0)}
              x2={px(1)}
              y1={py(0)}
              y2={py(1)}
            />
            {/* 曲线末点就是 (100%, 100%)，直接闭合回原点走的正是对角线，填出来的即基尼那块面积。 */}
            <path d={`M ${path} Z`} fill={SERIES} fillOpacity={0.12} />
            <path
              d={`M ${path}`}
              fill="none"
              stroke={SERIES}
              strokeLinejoin="round"
              strokeWidth={2}
            />
            {points.slice(1, -1).map((point) => (
              <circle
                cx={px(point.shotShare)}
                cy={py(point.attemptShare)}
                fill={SERIES}
                key={point.shotShare}
                r={3.5}
              />
            ))}
            <text fill={LABEL} fontSize={11} x={px(0)} y={py(1) - 4}>
              占次数 ↑
            </text>
            <text fill={LABEL} fontSize={11} textAnchor="end" x={px(1)} y={py(0) + 14}>
              占镜数 →
            </text>
          </svg>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-body-sm text-on-surface-variant">集中度</p>
            <p className="text-display font-medium text-on-surface tabular-nums">
              {concentration === null ? EMPTY : concentration.toFixed(2)}
            </p>
            <p className="text-body-sm text-on-surface-variant">
              0 是每个镜花的次数一样，越大越集中在个别镜
              {before === null ? '' : `；上期 ${before.toFixed(2)}`}
            </p>
            {/* 只有一档时（所有镜花的次数一样）没有队尾可说，表格也会是空的，两者一起省掉。 */}
            {tail === undefined ? (
              <p className="text-body-sm text-on-surface">每个镜花的出片次数都一样</p>
            ) : (
              <p className="text-body-sm text-on-surface">
                出片最多的 {formatRate(1 - tail.shotShare)} 的镜，吃掉了{' '}
                {formatRate(1 - tail.attemptShare)} 的次数
              </p>
            )}
            {rows.length === 0 ? null : (
              <details className="text-body-sm text-on-surface-variant">
                <summary className="cursor-pointer ui-focus">看数字</summary>
                <table className="mt-2 w-full border-collapse tabular-nums">
                  <thead>
                    <tr className="text-left">
                      <th className="py-1 font-normal" scope="col">
                        前这些镜
                      </th>
                      <th className="py-1 text-right font-normal" scope="col">
                        吃掉的出片次数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((point) => (
                      <tr className="border-t-[0.5px] border-border/70" key={point.shotShare}>
                        <td className="py-1">{formatRate(point.shotShare)}</td>
                        <td className="py-1 text-right">{formatRate(point.attemptShare)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        </div>
      )}
    </figure>
  )
}
