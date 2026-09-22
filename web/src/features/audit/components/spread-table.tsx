/** 耗时分布表：一行一段口径，列出平均、中位、最慢一成与样本数。行轴是口径不是人，所以不套 MetricsTable。 */

import type { Metrics } from '../audit.api'
import { EMPTY, formatCount, formatDuration } from '../format'

export type SpreadRow = {
  key: string
  label: string
  /** 标签下面那句口径解释。 */
  hint: string
  spread: Metrics['cycleSeconds']
  /** 这段口径算了多少条；上游段不给样本时为 null。 */
  sample: number | null
}

type SpreadTableProps = {
  title: string
  rows: readonly SpreadRow[]
  /** 样本列表头的 title 提示。 */
  sampleHint: string
  pending?: boolean
}

const COLUMNS = ['平均', '中位', '最慢一成（P90）'] as const

export function SpreadTable({ title, rows, sampleHint, pending = false }: SpreadTableProps) {
  return (
    <section
      aria-busy={pending}
      aria-label={title}
      className="flex min-w-0 flex-col rounded-lg bg-surface-container-lowest shadow-[var(--shadow-1)]"
    >
      <header className="px-5 pt-5 pb-3">
        <h3 className="text-title font-medium text-on-surface">{title}</h3>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-120 border-collapse text-body">
          <thead>
            <tr className="text-left text-body-sm text-on-surface-variant">
              <th className="px-5 py-2 font-normal" scope="col">
                口径
              </th>
              {COLUMNS.map((label) => (
                <th
                  className="px-3 py-2 text-right font-normal whitespace-nowrap"
                  key={label}
                  scope="col"
                >
                  {label}
                </th>
              ))}
              <th
                className="px-5 py-2 text-right font-normal whitespace-nowrap"
                scope="col"
                title={sampleHint}
              >
                样本
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t-[0.5px] border-border/70" key={row.key}>
                <th className="px-5 py-3 text-left font-normal" scope="row">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-on-surface">{row.label}</span>
                    <span className="text-body-sm text-on-surface-variant">{row.hint}</span>
                  </span>
                </th>
                {[
                  { key: 'avg', seconds: row.spread?.avg },
                  { key: 'median', seconds: row.spread?.median },
                  { key: 'p90', seconds: row.spread?.p90 },
                ].map((cell) => (
                  <td
                    className="px-3 py-3 text-right whitespace-nowrap text-on-surface tabular-nums"
                    key={cell.key}
                  >
                    {formatDuration(cell.seconds ?? null)}
                  </td>
                ))}
                <td className="px-5 py-3 text-right whitespace-nowrap text-on-surface-variant tabular-nums">
                  {row.sample === null || row.spread === null ? EMPTY : formatCount(row.sample)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
