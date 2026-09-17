/** 出片次数集中度（洛伦兹曲线）：按出片次数由少到多排列各镜，看少数镜占了多少出片次数。
 *
 * 只有几个点、没有时间轴，用不上 TrendChart 那套；这里手写 SVG，颜色同样走 token。 */

import { useId } from 'react'
import { EMPTY } from '../format'
import type { DistributionRow, LorenzPoint } from '../attempt-distribution'

type ConcentrationChartProps = {
  title: string
  points: readonly LorenzPoint[]
  /** 分档表的行，给「看数字」那张表。 */
  rows: readonly DistributionRow[]
  /** 出片次数最多的一成镜消耗的次数比例。 */
  topShare: number | null
  /** 上一期的同一口径，只作对照。 */
  beforeTopShare: number | null
  /** 集中度（基尼系数），放在表格末行给要跨期比的人。 */
  concentration: number | null
}

const SIZE = 240
const PAD = 18
const SERIES = 'var(--color-chart-1)'
const GRID = 'var(--color-border)'
const LABEL = 'var(--color-on-surface-muted)'

const px = (share: number) => PAD + share * SIZE
const py = (share: number) => PAD + SIZE - share * SIZE

/** 表里的比例取整：这张表看的是轻重，19.7% 与 20% 没区别，整数好读。 */
const whole = (share: number) => `${Math.round(share * 100)}%`

export function ConcentrationChart({
  title,
  points,
  rows,
  topShare,
  beforeTopShare,
  concentration,
}: ConcentrationChartProps) {
  const titleId = useId()
  const path = points.map((point) => `${px(point.shotShare)},${py(point.attemptShare)}`).join(' L ')
  // 只有一档时各镜次数一致，既没有「最费劲的一成」可言，分档表也只有一行，两者一起换成一句话。
  const even = rows.length <= 1

  return (
    <figure
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
    >
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-title font-medium text-on-surface" id={titleId}>
          {title}
        </h3>
      </figcaption>
      {points.length === 0 ? (
        <p className="grid h-52 place-items-center text-body text-on-surface-variant">
          该时段无出片记录
        </p>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex w-full shrink-0 flex-col gap-1 sm:w-52">
            <svg
              aria-label={`${title}：虚线表示各镜出片次数一致；实线与虚线偏离越大，出片次数越集中于少数镜`}
              className="h-52 w-full"
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
              {/* 曲线末点就是 (100%, 100%)，直接闭合回原点走的正是那条虚线。 */}
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
                累计出片次数
              </text>
              <text fill={LABEL} fontSize={11} textAnchor="end" x={px(1)} y={py(0) + 14}>
                镜（出片次数由少到多）
              </text>
            </svg>
            <p className="flex items-center gap-2 text-body-sm text-on-surface-variant">
              <span aria-hidden className="w-4 border-t-2 border-dashed border-border" />
              各镜次数一致
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            {even || topShare === null ? (
              <p className="text-body text-on-surface">各镜出片次数一致</p>
            ) : (
              <>
                <p className="text-body-sm text-on-surface-variant">
                  出片次数最多的 10% 的镜占全部次数
                </p>
                <p className="text-display font-medium text-on-surface tabular-nums">
                  {whole(topShare)}
                </p>
                {beforeTopShare === null ? null : (
                  <p className="text-body-sm text-on-surface-variant tabular-nums">
                    上期 {whole(beforeTopShare)}
                  </p>
                )}
              </>
            )}
            {even ? null : (
              <details className="text-body-sm text-on-surface-variant">
                <summary className="cursor-pointer ui-focus">看数字</summary>
                <table className="mt-2 w-full border-collapse tabular-nums">
                  <thead>
                    <tr className="text-left">
                      <th className="py-1 font-normal" scope="col">
                        出片次数
                      </th>
                      <th className="py-1 text-right font-normal" scope="col">
                        镜数
                      </th>
                      <th className="py-1 text-right font-normal" scope="col">
                        占全部次数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr className="border-t-[0.5px] border-border/70" key={row.attempts}>
                        <th className="py-1 text-left font-normal" scope="row">
                          {row.atLeast ? `${row.attempts} 次以上` : `${row.attempts} 次`}
                        </th>
                        <td className="py-1 text-right">{row.shots}</td>
                        <td className="py-1 text-right">{whole(row.attemptShare)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2">
                  集中度 {concentration === null ? EMPTY : concentration.toFixed(2)} · 越大越集中
                </p>
              </details>
            )}
          </div>
        </div>
      )}
    </figure>
  )
}
