/** 按人、按需求单的排行表：第一列名字，后面几列指标；排序列内嵌一条相对最大值的横条。 */

import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import type { Metrics } from '../audit.api'

export type MetricsColumn = {
  key: string
  label: string
  /** 表头的一句解释，挂在 title 上。 */
  hint?: string
  render: (metrics: Metrics) => string
  /** 内嵌横条按这个数取长度；只给排序列。 */
  bar?: (metrics: Metrics) => number
}

export type MetricsRow = {
  key: string
  name: string
  /** 名字下面的小字，如需求单标题旁的状态。 */
  meta?: ReactNode
  metrics: Metrics
}

type MetricsTableProps = {
  caption: string
  nameLabel: string
  columns: readonly MetricsColumn[]
  rows: readonly MetricsRow[]
  empty: string
  pending?: boolean
}

export function MetricsTable({
  caption,
  nameLabel,
  columns,
  rows,
  empty,
  pending = false,
}: MetricsTableProps) {
  const barColumn = columns.find((column) => column.bar !== undefined)
  const barMax = Math.max(1, ...rows.map((row) => barColumn?.bar?.(row.metrics) ?? 0))

  return (
    <section
      aria-busy={pending}
      aria-label={caption}
      className="flex min-w-0 flex-col rounded-lg bg-surface-container-lowest shadow-[var(--shadow-1)]"
    >
      <header className="flex items-baseline justify-between px-5 pt-5 pb-3">
        <h3 className="text-title font-medium text-on-surface">{caption}</h3>
        <span className="text-body-sm text-on-surface-variant">{rows.length} 行</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-140 border-collapse text-body">
          <thead>
            <tr className="text-left text-body-sm text-on-surface-variant">
              <th className="px-5 py-2 font-normal" scope="col">
                {nameLabel}
              </th>
              {columns.map((column) => (
                <th
                  className="px-2 py-2 text-right font-normal whitespace-nowrap"
                  key={column.key}
                  scope="col"
                  title={column.hint}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-10 text-center text-on-surface-variant"
                  colSpan={columns.length + 1}
                >
                  {pending ? '正在读取…' : empty}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  className="ui-state border-t-[0.5px] border-border/70 hover:bg-state-hover"
                  key={row.key}
                >
                  <th className="max-w-64 px-5 py-3 text-left font-normal" scope="row">
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden
                        className={cn(
                          'grid size-6 shrink-0 place-items-center rounded-full text-label tabular-nums',
                          index < 3
                            ? 'bg-primary-container text-on-primary-container'
                            : 'bg-surface-container text-on-surface-variant',
                        )}
                      >
                        {index + 1}
                      </span>
                      <span className="flex min-w-0 grow flex-col">
                        <span className="truncate font-medium text-on-surface" title={row.name}>
                          {row.name}
                        </span>
                        {row.meta === undefined ? null : (
                          <span className="truncate text-body-sm text-on-surface-variant">
                            {row.meta}
                          </span>
                        )}
                        {barColumn?.bar === undefined ? null : (
                          <span
                            aria-hidden
                            className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-container"
                          >
                            <span
                              className="block h-full rounded-full bg-primary"
                              style={{
                                width: `${Math.round((barColumn.bar(row.metrics) / barMax) * 100)}%`,
                              }}
                            />
                          </span>
                        )}
                      </span>
                    </span>
                  </th>
                  {columns.map((column) => (
                    <td
                      className={cn(
                        'px-2 py-3 text-right whitespace-nowrap text-on-surface tabular-nums',
                        column.bar !== undefined && 'font-medium',
                      )}
                      key={column.key}
                    >
                      {column.render(row.metrics)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
