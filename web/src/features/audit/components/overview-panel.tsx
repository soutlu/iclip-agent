/** 总览：结果 → 效率 → 消耗 → 问题，一屏看完；人和需求单两张排行表放在下面下钻。 */

import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'
import { ANOMALY_META } from '../anomaly-kinds'
import {
  bucketFor,
  useAuditAnomalies,
  useAuditSummary,
  type AnomalyKind,
  type AuditScope,
  type Metrics,
} from '../audit.api'
import {
  compareWithPrevious,
  EMPTY,
  formatCount,
  formatDuration,
  formatPeriodLabel,
  formatRate,
  formatTimes,
  formatTokens,
} from '../format'
import { MetricsTable, type MetricsColumn } from './metrics-table'
import { StatTile } from './stat-tile'
import { TrendChart } from './trend-chart'

type OverviewPanelProps = {
  scope: AuditScope
  /** 上游归属用户名 → 显示名；名册里没有就原样显示。 */
  nameOf: (userName: string) => string | undefined
  onOpenAnomalies: () => void
}

const SHOT_NOTE = '只统计带镜号的出片'
const USAGE_NOTE = '自用量台账上线起累计'

const RANK_COLUMNS: readonly MetricsColumn[] = [
  {
    key: 'deliveries',
    label: '成片件数',
    hint: '有成片的需求单各一件，没挂需求单的对话各一件',
    render: (m) => formatCount(m.deliveries),
    bar: (m) => m.deliveries,
  },
  {
    key: 'videos',
    label: '成片视频',
    render: (m) => formatCount(m.completedVideos),
  },
  {
    key: 'attempts',
    label: '每镜次数',
    hint: '越接近 1 越好',
    render: (m) => formatTimes(m.attemptsPerShot),
  },
  {
    key: 'firstPass',
    label: '一次通过',
    render: (m) => formatRate(m.firstPassRate),
  },
  {
    key: 'cycle',
    label: '交付周期',
    hint: '中位数',
    render: (m) => formatDuration(m.cycleSeconds?.median ?? null),
  },
  {
    key: 'tokens',
    label: 'token',
    render: (m) => formatTokens(m.usage.totalTokens),
  },
]

export function OverviewPanel({ scope, nameOf, onOpenAnomalies }: OverviewPanelProps) {
  const { current, previous } = useAuditSummary(scope)
  const anomalies = useAuditAnomalies(scope, null)
  const summary = current.data
  const overall = summary?.overall
  const before = previous.data
  const series = summary?.series ?? []
  const bucket = bucketFor(scope)
  const pending = current.isPending

  if (current.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16" role="alert">
        <p className="text-body text-error">{current.error.message}</p>
        <Button
          leadingIcon="refresh"
          onClick={() => void current.refetch()}
          size="md"
          variant="outlined"
        >
          重新加载
        </Button>
      </div>
    )
  }

  const trendOf = (pick: (metrics: Metrics) => number | null) =>
    series.length >= 2 ? series.map((period) => pick(period.metrics) ?? 0) : undefined

  const anomalyItems = anomalies.data?.pages.flatMap((page) => page.items) ?? []
  const anomalyCounts = new Map<AnomalyKind, number>()
  for (const item of anomalyItems) {
    anomalyCounts.set(item.kind, (anomalyCounts.get(item.kind) ?? 0) + 1)
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="头条指标" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          delta={compareWithPrevious(overall?.deliveries ?? null, before?.deliveries)}
          label="成片件数"
          pending={pending}
          sub={
            overall === undefined
              ? undefined
              : `需求单 ${overall.deliveredTasks} · 无单对话 ${overall.deliveredOrphanConversations}`
          }
          trend={trendOf((m) => m.deliveries)}
          value={overall === undefined ? EMPTY : formatCount(overall.deliveries)}
        />
        <StatTile
          delta={compareWithPrevious(overall?.attemptsPerShot ?? null, before?.attemptsPerShot, {
            lowerIsBetter: true,
          })}
          label="每镜平均出片次数"
          note={SHOT_NOTE}
          pending={pending}
          sub="越接近 1 越好"
          trend={trendOf((m) => m.attemptsPerShot)}
          value={formatTimes(overall?.attemptsPerShot ?? null)}
        />
        <StatTile
          delta={compareWithPrevious(overall?.firstPassRate ?? null, before?.firstPassRate)}
          label="一次通过率"
          note={SHOT_NOTE}
          pending={pending}
          sub={
            overall === undefined ? undefined : `${overall.firstPassShots} / ${overall.shots} 镜`
          }
          trend={trendOf((m) => m.firstPassRate)}
          value={formatRate(overall?.firstPassRate ?? null)}
        />
        <StatTile
          delta={compareWithPrevious(
            overall?.cycleSeconds?.median ?? null,
            before?.cycleSeconds?.median ?? null,
            { lowerIsBetter: true },
          )}
          label="交付周期"
          pending={pending}
          sub={
            overall?.cycleSeconds == null
              ? '首次运行到最后一条成片'
              : `最慢一成 ${formatDuration(overall.cycleSeconds.p90)}`
          }
          trend={trendOf((m) => m.cycleSeconds?.median ?? null)}
          value={formatDuration(overall?.cycleSeconds?.median ?? null)}
        />
      </section>

      <section aria-label="趋势" className="grid gap-4 lg:grid-cols-2">
        <TrendChart
          description="按时段的成片件数"
          format={(value) => formatCount(Math.round(value))}
          kind="bar"
          points={series.map((period) => ({
            key: period.periodStart,
            label: formatPeriodLabel(period.periodStart, bucket),
            value: period.metrics.deliveries,
          }))}
          title="成片件数"
        />
        <TrendChart
          description="首条即成功的镜占比"
          format={(value) => `${Math.round(value * 100)}%`}
          kind="line"
          max={1}
          points={series.map((period) => ({
            key: period.periodStart,
            label: formatPeriodLabel(period.periodStart, bucket),
            value: period.metrics.firstPassRate,
          }))}
          title="一次通过率"
        />
      </section>

      <section aria-label="模型消耗" className="grid gap-4 sm:grid-cols-3">
        <StatTile
          delta={compareWithPrevious(
            overall?.usage.totalTokens ?? null,
            before?.usage.totalTokens ?? null,
            { lowerIsBetter: true },
          )}
          label="模型 token"
          note={USAGE_NOTE}
          pending={pending}
          sub={overall === undefined ? undefined : `${formatCount(overall.usage.requests)} 次请求`}
          value={overall === undefined ? EMPTY : formatTokens(overall.usage.totalTokens)}
        />
        <article
          aria-label="缓存命中率"
          className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
        >
          <h3 className="text-body text-on-surface-variant">缓存命中率</h3>
          <p className="text-headline-lg font-semibold tracking-tight text-on-surface tabular-nums">
            {formatRate(overall?.usage.cacheHitRate ?? null)}
          </p>
          <div
            aria-label="缓存命中率"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round((overall?.usage.cacheHitRate ?? 0) * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-surface-container"
            role="meter"
          >
            <span
              className="block h-full rounded-full bg-primary ui-motion-m"
              style={{ width: `${Math.round((overall?.usage.cacheHitRate ?? 0) * 100)}%` }}
            />
          </div>
          <p className="text-body-sm text-on-surface-variant">
            {overall === undefined
              ? '缓存读取占全部输入的比例'
              : `缓存读取 ${formatTokens(overall.usage.cacheReadTokens)} · 新输入 ${formatTokens(overall.usage.inputTokens)}`}
          </p>
        </article>
        <StatTile
          delta={compareWithPrevious(
            overall?.tokensPerDelivery ?? null,
            before?.tokensPerDelivery ?? null,
            { lowerIsBetter: true },
          )}
          label="每件成片 token"
          pending={pending}
          sub="出一件片烧多少"
          value={
            overall?.tokensPerDelivery == null
              ? EMPTY
              : formatTokens(Math.round(overall.tokensPerDelivery))
          }
        />
      </section>

      <section
        aria-label="异常概览"
        className="flex flex-col gap-3 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-title font-medium text-on-surface">异常</h3>
          <Button onClick={onOpenAnomalies} size="md" trailingIcon="next" variant="ghost">
            查看全部
          </Button>
        </header>
        {anomalies.isPending ? (
          <p className="text-body-sm text-on-surface-variant">正在读取…</p>
        ) : anomalyItems.length === 0 ? (
          <p className="flex items-center gap-2 text-body text-on-surface-variant">
            <Icon className="text-primary" decorative name="success" size="sm" />
            这个范围里没有异常
          </p>
        ) : (
          <ul aria-label="异常按种类" className="flex flex-wrap gap-2">
            {[...anomalyCounts.entries()].map(([kind, count]) => (
              <li key={kind}>
                <Tag
                  variant={
                    ANOMALY_META[kind].tone === 'bad'
                      ? 'error'
                      : ANOMALY_META[kind].tone === 'warn'
                        ? 'running'
                        : 'soft'
                  }
                >
                  {ANOMALY_META[kind].label}
                  <span className="tabular-nums">{count}</span>
                </Tag>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="排行" className="grid gap-4 xl:grid-cols-2">
        <MetricsTable
          caption="按人"
          columns={RANK_COLUMNS}
          empty="这个范围里没有人出过片"
          nameLabel="人"
          pending={pending}
          rows={(summary?.users ?? []).map((row) => ({
            key: row.userName,
            name: nameOf(row.userName) ?? row.userName,
            meta: nameOf(row.userName) === undefined ? undefined : row.userName,
            metrics: row.metrics,
          }))}
        />
        <MetricsTable
          caption="按需求单"
          columns={RANK_COLUMNS}
          empty="这个范围里没有需求单有动静"
          nameLabel="需求单"
          pending={pending}
          rows={(summary?.tasks ?? []).map((row) => ({
            key: row.taskId,
            name: row.title || '（无标题）',
            meta: row.metrics.deliveries > 0 ? '已成片' : '尚无成片',
            metrics: row.metrics,
          }))}
        />
      </section>
    </div>
  )
}
