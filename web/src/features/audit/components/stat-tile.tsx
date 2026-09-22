/** 头条指标卡：一句人话的名字、一个大数、较上期的变化与一条迷你趋势。 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { Delta } from '../format'
import { Sparkline } from './sparkline'

type StatTileProps = {
  label: string
  value: string
  /** 大数下面的一句补充，如「越接近 1 越好」或「最慢一成 2.1 小时」；窄卡上最多折两行。 */
  sub?: string | undefined
  delta?: Delta | null
  /** 迷你趋势的各期值；没数据的期给 null，画成断开而不是 0。 */
  trend?: readonly (number | null)[] | undefined
  /** 大数下面的一条占比；给了就画，null 画成空条。 */
  meter?: number | null
  /** 角标：数据口径的诚实说明。 */
  note?: string
  pending?: boolean
}

const TONE_CLASS = {
  better: 'text-primary',
  worse: 'text-error',
  flat: 'text-on-surface-variant',
} as const

export function StatTile({
  label,
  value,
  sub,
  delta,
  trend,
  meter,
  note,
  pending = false,
}: StatTileProps) {
  const percent = Math.round((meter ?? 0) * 100)
  return (
    <article
      aria-busy={pending}
      aria-label={label}
      className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-body text-on-surface-variant">{label}</h3>
        {note === undefined ? null : (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-caption text-on-surface-muted"
            title={note}
          >
            <Icon decorative name="alert" size="xs" />
            <span className="max-w-32 truncate">{note}</span>
          </span>
        )}
      </header>
      <div className="flex items-end justify-between gap-3">
        <p
          className={cn(
            'min-w-0 text-headline-lg font-semibold tracking-tight text-on-surface tabular-nums ui-motion-m',
            pending && 'text-on-surface-faint',
          )}
        >
          {value}
        </p>
        {trend === undefined ? null : <Sparkline values={trend} />}
      </div>
      {meter === undefined ? null : (
        <div
          aria-label={label}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="h-1.5 overflow-hidden rounded-full bg-surface-container"
          role="meter"
        >
          <span
            className="block h-full rounded-full bg-primary ui-motion-m"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <footer className="flex min-h-5 items-center gap-2 text-body-sm text-on-surface-variant">
        {delta === null || delta === undefined ? null : (
          <span
            className={cn('inline-flex items-center gap-0.5 font-medium', TONE_CLASS[delta.tone])}
          >
            {delta.tone === 'flat' ? null : (
              <Icon
                className={delta.text.startsWith('+') ? '-rotate-90' : 'rotate-90'}
                decorative
                name="next"
                size="xs"
              />
            )}
            {delta.text}
            <span className="font-normal text-on-surface-variant">较上期</span>
          </span>
        )}
        {sub === undefined ? null : (
          <span className="line-clamp-2 min-w-0" title={sub}>
            {sub}
          </span>
        )}
      </footer>
    </article>
  )
}
