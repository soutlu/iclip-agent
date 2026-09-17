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
import {
  cumulativePass,
  distributionRows,
  foldTail,
  gini,
  lorenzPoints,
  topShareOfAttempts,
} from '../attempt-distribution'
import { ConcentrationChart } from './concentration-chart'
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
const SAMPLE_HINT = '上游段不给样本：没留提交时刻的记录不计入这一行'
/** 出片次数画到第几档为止，再多的并成「N 次以上」。 */
const ATTEMPT_CAP = 5

const RANK_COLUMNS: readonly MetricsColumn[] = [
  {
    key: 'deliveries',
    label: '成片件数',
    hint: '有成片的需求单各一件，没挂需求单的对话各一件',
    render: (m) => formatCount(m.deliveries),
    bar: (m) => m.deliveries,
  },
  {
    key: 'runs',
    label: '运行次数',
    hint: 'agent 运行次数，只跑过没出片的人也在这里',
    render: (m) => formatCount(m.runs),
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
    render: (m) => formatRate(m.oneTakeRate),
  },
  {
    key: 'cycleMedian',
    label: '周期中位',
    render: (m) => formatDuration(m.cycleSeconds?.median ?? null),
  },
  {
    key: 'cycleAvg',
    label: '周期平均',
    render: (m) => formatDuration(m.cycleSeconds?.avg ?? null),
  },
  {
    key: 'tokens',
    label: 'token',
    render: (m) => formatTokens(m.usage.totalTokens),
  },
]

/** 耗时分布表的三行：一段口径，从 metrics 上取一组分布与它的样本数。 */
const SPREAD_ROWS: readonly {
  key: string
  label: string
  hint: string
  spread: (metrics: Metrics) => Metrics['cycleSeconds']
  sample: (metrics: Metrics) => number | null
}[] = [
  {
    key: 'cycle',
    label: '交付周期',
    hint: '首次运行到最后一条成片',
    spread: (m) => m.cycleSeconds,
    sample: (m) => m.deliveredConversations,
  },
  {
    key: 'video',
    label: '单条出片',
    hint: '受理到出结果',
    spread: (m) => m.videoSeconds,
    sample: (m) => m.completedVideos,
  },
  {
    key: 'upstream',
    label: '上游段',
    hint: '提交上游到出结果',
    spread: (m) => m.upstreamSeconds,
    sample: () => null,
  },
]

export function OverviewPanel({ scope, nameOf, onOpenAnomalies }: OverviewPanelProps) {
  const { current, previous } = useAuditSummary(scope)
  const anomalies = useAuditAnomalies(scope, null)
  const summary = current.data
  const overall = summary?.overall
  const before = previous.data?.overall
  const series = summary?.series ?? []
  const beforeSeries = previous.data?.series ?? []
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

  // 后端补齐了空期：计数是 0、比率与分布是 null，null 交给迷你趋势断开，不当 0 画。
  const trendOf = (pick: (metrics: Metrics) => number | null) =>
    series.length >= 2 ? series.map((period) => pick(period.metrics)) : undefined

  const pointsOf = (pick: (metrics: Metrics) => number | null) =>
    series.map((period) => ({
      key: period.periodStart,
      label: formatPeriodLabel(period.periodStart, bucket),
      value: pick(period.metrics),
    }))

  /** 上一期同粒度的一条序列，按下标叠在本期上；没有上一期就不画对照。 */
  const beforeOf = (pick: (metrics: Metrics) => number | null) =>
    beforeSeries.length === 0 ? undefined : beforeSeries.map((period) => pick(period.metrics))

  // 出片次数：折尾只为画图，本期与上期折到同一档位才能按下标对齐；集中度一律吃未折叠的原始分布。
  const distribution = summary?.attemptDistribution ?? []
  const beforeDistribution = previous.data?.attemptDistribution ?? []
  const pass = cumulativePass(foldTail(distribution, ATTEMPT_CAP))
  const passPoints = pass.map((point) => {
    // 折尾后的末档装着「cap 次及以上」，标签与悬停都照这个说，不能写成「以内完成」。
    const tail = point.attempts === ATTEMPT_CAP
    const label = tail ? `${ATTEMPT_CAP} 次以上` : `${point.attempts} 次`
    return {
      key: String(point.attempts),
      label,
      tooltipLabel: tail ? label : `${label}以内完成`,
      value: point.cumulative,
    }
  })
  const beforePassAt = new Map(
    cumulativePass(foldTail(beforeDistribution, ATTEMPT_CAP)).map((point) => [
      point.attempts,
      point.cumulative,
    ]),
  )
  const beforePass =
    beforeDistribution.length === 0
      ? undefined
      : passPoints.map((point) => beforePassAt.get(Number(point.key)) ?? null)
  // 末档一定收在 100%，「尚有 N 镜未完成」在那里恒为 0，不写。
  const attemptNotes = new Map(
    pass.map((point, index) => [
      String(point.attempts),
      index === pass.length - 1
        ? `本档 ${point.shots} 镜`
        : `本档 ${point.shots} 镜 · 尚有 ${point.entering - point.shots} 镜未完成`,
    ]),
  )
  const passSummary =
    pass.length < 2
      ? undefined
      : `一次完成 ${Math.round((pass[0]?.cumulative ?? 0) * 100)}% · 两次以内 ${Math.round(
          (pass[1]?.cumulative ?? 0) * 100,
        )}%`
  const lorenz = lorenzPoints(distribution)
  const rows = distributionRows(distribution, ATTEMPT_CAP)
  const topShare = topShareOfAttempts(distribution)
  const beforeTopShare = topShareOfAttempts(beforeDistribution)
  const concentration = gini(distribution)

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
          delta={compareWithPrevious(overall?.oneTakeRate ?? null, before?.oneTakeRate)}
          label="一次通过率"
          note={SHOT_NOTE}
          pending={pending}
          sub={overall === undefined ? undefined : `${overall.oneTakeShots} / ${overall.shots} 镜`}
          trend={trendOf((m) => m.oneTakeRate)}
          value={formatRate(overall?.oneTakeRate ?? null)}
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

      <section
        aria-busy={pending}
        aria-label="耗时分布"
        className="flex min-w-0 flex-col rounded-lg bg-surface-container-lowest shadow-[var(--shadow-1)]"
      >
        <header className="px-5 pt-5 pb-3">
          <h3 className="text-title font-medium text-on-surface">耗时分布</h3>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-120 border-collapse text-body">
            <thead>
              <tr className="text-left text-body-sm text-on-surface-variant">
                <th className="px-5 py-2 font-normal" scope="col">
                  口径
                </th>
                {['平均', '中位', '最慢一成（P90）'].map((label) => (
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
                  title={SAMPLE_HINT}
                >
                  样本
                </th>
              </tr>
            </thead>
            <tbody>
              {SPREAD_ROWS.map((row) => {
                const spread = overall === undefined ? null : row.spread(overall)
                const sample = overall === undefined ? null : row.sample(overall)
                return (
                  <tr className="border-t-[0.5px] border-border/70" key={row.key}>
                    <th className="px-5 py-3 text-left font-normal" scope="row">
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium text-on-surface">{row.label}</span>
                        <span className="text-body-sm text-on-surface-variant">{row.hint}</span>
                      </span>
                    </th>
                    {[
                      { key: 'avg', seconds: spread?.avg },
                      { key: 'median', seconds: spread?.median },
                      { key: 'p90', seconds: spread?.p90 },
                    ].map((cell) => (
                      <td
                        className="px-3 py-3 text-right whitespace-nowrap text-on-surface tabular-nums"
                        key={cell.key}
                      >
                        {formatDuration(cell.seconds ?? null)}
                      </td>
                    ))}
                    <td className="px-5 py-3 text-right whitespace-nowrap text-on-surface-variant tabular-nums">
                      {sample === null || spread === null ? EMPTY : formatCount(sample)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="出片次数分析" className="grid gap-4 lg:grid-cols-2">
        <TrendChart
          curve="step"
          description={passSummary ?? '出到第 n 次为止已完成的镜占比'}
          detail={(point) => attemptNotes.get(point.key)}
          empty="该时段无出片记录"
          format={(value) => `${Math.round(value * 100)}%`}
          kind="line"
          max={1}
          points={passPoints}
          previous={beforePass}
          title="出片次数分布"
        />
        <ConcentrationChart
          beforeTopShare={beforeTopShare}
          concentration={concentration}
          points={lorenz}
          rows={rows}
          topShare={topShare}
          title="出片次数集中度"
        />
      </section>

      <section aria-label="趋势" className="grid gap-4 lg:grid-cols-2">
        <TrendChart
          description="按时段的成片件数"
          format={(value) => formatCount(Math.round(value))}
          kind="bar"
          points={pointsOf((m) => m.deliveries)}
          previous={beforeOf((m) => m.deliveries)}
          title="成片件数"
        />
        <TrendChart
          description="只出了一条就成的镜占比"
          format={(value) => `${Math.round(value * 100)}%`}
          kind="line"
          max={1}
          points={pointsOf((m) => m.oneTakeRate)}
          previous={beforeOf((m) => m.oneTakeRate)}
          title="一次通过率"
        />
        <TrendChart
          baseline={1}
          description="每镜平均出片次数"
          format={formatTimes}
          kind="line"
          points={pointsOf((m) => m.attemptsPerShot)}
          previous={beforeOf((m) => m.attemptsPerShot)}
          title="每镜次数"
        />
        <TrendChart
          description="首次运行到最后一条成片"
          format={formatDuration}
          kind="line"
          points={pointsOf((m) => m.cycleSeconds?.median ?? null)}
          previous={beforeOf((m) => m.cycleSeconds?.median ?? null)}
          title="交付周期中位数"
        />
      </section>

      <section aria-label="模型消耗" className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            delta={compareWithPrevious(
              overall?.usage.totalTokens ?? null,
              before?.usage.totalTokens ?? null,
              { lowerIsBetter: true },
            )}
            label="模型 token"
            note={USAGE_NOTE}
            pending={pending}
            sub={
              overall === undefined ? undefined : `${formatCount(overall.usage.requests)} 次请求`
            }
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
        </div>
        <TrendChart
          description="按时段的 token 消耗"
          format={formatTokens}
          kind="bar"
          points={pointsOf((m) => m.usage.totalTokens)}
          previous={beforeOf((m) => m.usage.totalTokens)}
          title="模型 token 趋势"
        />
      </section>

      <section
        aria-label="异常概览"
        className="flex flex-col gap-3 rounded-lg bg-surface-container-lowest p-5 shadow-[var(--shadow-1)]"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-baseline gap-2 text-title font-medium text-on-surface">
            异常
            {/* 概览只拿了第一页，还有下一页时说清这是「最近一批」，不当总数。 */}
            {anomalies.hasNextPage ? (
              <span className="text-body-sm font-normal text-on-surface-variant">
                只数了最近 {anomalyItems.length} 条
              </span>
            ) : null}
          </h3>
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
          empty="这个范围里没有人出过片，也没人跑过"
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
