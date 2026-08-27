import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ANALYTICS_RANGE_OPTIONS,
  ANALYTICS_SOURCE_OPTIONS,
  type AnalyticsFilterOption,
  type AnalyticsRangeId,
  type AnalyticsSourceId,
  type AnalyticsSummaryMetric,
  type GenerationAnalyticsSnapshot,
} from '@/features/analytics/api/generation-analytics'
import { ProducerUserMenu } from '@/features/auth'
import { formatDateTime } from '@/shared/lib/datetime'
import HippoIcon from '@/shared/ui/icons/HippoIcon'
import { DistributionChart, TrendChart } from './AnalyticsCharts'
import { AttentionTable, UserStatsTable } from './AnalyticsTables'
import { createSummaryMetrics, fetchGenerationAnalytics } from './analytics-snapshot.utils'

type AnalyticsFilterButtonProps<TId extends string> = {
  active: boolean
  option: AnalyticsFilterOption<TId>
  onSelect: (optionId: TId) => void
}

type SummaryMetricItemProps = {
  metric: AnalyticsSummaryMetric
}

type AnalyticsLoadState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 渲染 Producer 生成统计客户端页面。
 *
 * @returns 生成统计页面。
 */
export default function AnalyticsRoute() {
  const [activeRangeId, setActiveRangeId] = useState<AnalyticsRangeId>('30d')
  const [activeSourceId, setActiveSourceId] = useState<AnalyticsSourceId>('all')
  const [snapshot, setSnapshot] = useState<GenerationAnalyticsSnapshot | null>(null)
  const [loadState, setLoadState] = useState<AnalyticsLoadState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    setLoadState('loading')
    setErrorMessage(null)
    setSnapshot(null)

    fetchGenerationAnalytics(
      {
        range: activeRangeId,
        source: activeSourceId,
      },
      controller.signal,
    )
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }

        setErrorMessage(error instanceof Error ? error.message : '加载统计数据失败')
        setLoadState('error')
      })

    return () => {
      controller.abort()
    }
  }, [activeRangeId, activeSourceId])

  return (
    <div className="home-workspace analytics-workspace relative flex h-dvh max-h-dvh flex-col overflow-hidden">
      <header className="layer-header pointer-events-none absolute inset-x-0 top-0 flex h-[var(--layout-project-header-height)] items-center justify-between px-4 sm:px-8">
        <Link
          to="/"
          aria-label="返回 Producer 首页"
          className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-[var(--home-border)] bg-[var(--home-surface)] px-3 text-body-sm font-semibold text-[var(--home-text)] no-underline backdrop-blur-xl transition hover:bg-[var(--home-surface-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chat-focus-ring"
        >
          <HippoIcon name="back" size={15} />
          <span>首页</span>
        </Link>
        <Link to="/" className="analytics-brand-title home-title pointer-events-auto no-underline">
          Producer Studio is here
        </Link>
        <div className="pointer-events-auto flex items-center gap-1">
          <ProducerUserMenu className="ml-1" />
        </div>
      </header>

      <main className="hide-scrollbar relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
        <section className="hide-scrollbar layer-content relative flex min-h-0 max-w-full flex-1 flex-col items-center overflow-y-auto px-4 pt-24 pb-12 sm:px-8 sm:pt-28 sm:pb-16">
          <div className="analytics-shell w-full max-w-[min(1640px,calc(100vw-64px))]">
            <div className="analytics-page-heading">
              <div>
                <p className="analytics-eyebrow">Generation Analytics</p>
                <h1>生成统计</h1>
              </div>
              <div className="analytics-updated">
                <span className="analytics-updated-icon" aria-hidden="true" />
                <div>
                  <span>更新时间</span>
                  <strong>
                    {snapshot
                      ? formatDateTime(snapshot.generatedAt)
                      : loadState === 'error'
                        ? '加载失败'
                        : '加载中'}
                  </strong>
                </div>
              </div>
            </div>

            <div className="analytics-filter-bar">
              <fieldset className="analytics-filter-group">
                <legend className="sr-only">时间范围</legend>
                {ANALYTICS_RANGE_OPTIONS.map((option) => (
                  <AnalyticsFilterButton
                    key={option.id}
                    active={activeRangeId === option.id}
                    option={option}
                    onSelect={setActiveRangeId}
                  />
                ))}
              </fieldset>
              <fieldset className="analytics-filter-group">
                <legend className="sr-only">生成类型</legend>
                {ANALYTICS_SOURCE_OPTIONS.map((option) => (
                  <AnalyticsFilterButton
                    key={option.id}
                    active={activeSourceId === option.id}
                    option={option}
                    onSelect={setActiveSourceId}
                  />
                ))}
              </fieldset>
            </div>

            {loadState === 'loading' ? (
              <AnalyticsStatePanel
                title="正在加载真实统计数据"
                description="读取后端生成统计接口，请稍候。"
              />
            ) : null}
            {loadState === 'error' ? (
              <AnalyticsStatePanel
                title="统计数据加载失败"
                description={errorMessage ?? '请稍后重试。'}
              />
            ) : null}
            {snapshot ? <AnalyticsDashboard snapshot={snapshot} /> : null}
          </div>
        </section>
      </main>
    </div>
  )
}

/**
 * 渲染真实统计面板。
 *
 * @param props - 统计面板属性。
 * @param props.snapshot - 后端统计快照。
 * @returns 统计看板主体。
 */
function AnalyticsDashboard({ snapshot }: { snapshot: GenerationAnalyticsSnapshot }) {
  const summaryMetrics = useMemo(() => createSummaryMetrics(snapshot), [snapshot])

  return (
    <>
      <section className="analytics-kpi-ribbon" aria-label="核心统计指标">
        <ul className="analytics-kpi-list">
          {summaryMetrics.map((metric) => (
            <SummaryMetricItem key={metric.id} metric={metric} />
          ))}
        </ul>
      </section>

      <section className="analytics-chart-surface" aria-label="生成趋势与分布">
        <div className="analytics-trend-section">
          <div className="analytics-section-heading">
            <h2>生成趋势</h2>
          </div>
          <TrendChart points={snapshot.trendPoints} />
        </div>

        <div className="analytics-distribution-column">
          <section className="analytics-distribution-section" aria-label="时长分布">
            <div className="analytics-section-heading">
              <h2>时长分布</h2>
            </div>
            <DistributionChart items={snapshot.durationDistribution} title="时长分布" />
          </section>

          <section className="analytics-distribution-section" aria-label="Shot 生成次数分布">
            <div className="analytics-section-heading">
              <h2>Shot 生成次数分布</h2>
            </div>
            <DistributionChart items={snapshot.retryDistribution} title="Shot 生成次数分布" />
          </section>
        </div>
      </section>

      <section className="analytics-detail-surface" aria-label="用户与项目明细">
        <UserStatsTable rows={snapshot.userStats} />
        <AttentionTable rows={snapshot.attentionItems} />
      </section>
    </>
  )
}

/**
 * 渲染统计页面状态提示。
 *
 * @param props - 状态提示属性。
 * @param props.description - 状态说明。
 * @param props.title - 状态标题。
 * @returns 状态提示面板。
 */
function AnalyticsStatePanel({ description, title }: { description: string; title: string }) {
  return (
    <div className="analytics-state-panel" role="status">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  )
}

/**
 * 渲染统计筛选按钮。
 *
 * @param props - 筛选按钮属性。
 * @param props.active - 当前按钮是否选中。
 * @param props.onSelect - 点击后选中当前筛选项。
 * @param props.option - 筛选项配置。
 * @returns 筛选按钮。
 */
function AnalyticsFilterButton<TId extends string>({
  active,
  onSelect,
  option,
}: AnalyticsFilterButtonProps<TId>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className="analytics-filter-button"
      onClick={() => onSelect(option.id)}
    >
      {option.label}
    </button>
  )
}

/**
 * 渲染单个核心统计指标。
 *
 * @param props - 指标属性。
 * @param props.metric - 指标展示数据。
 * @returns 指标元素。
 */
function SummaryMetricItem({ metric }: SummaryMetricItemProps) {
  return (
    <li className="analytics-kpi-item" data-metric={metric.id}>
      <span className="analytics-kpi-symbol" aria-hidden="true" />
      <div className="analytics-kpi-copy">
        <span>{metric.label}</span>
        <strong>{metric.value}</strong>
      </div>
    </li>
  )
}
