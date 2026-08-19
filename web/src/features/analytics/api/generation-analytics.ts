export type AnalyticsRangeId = '1d' | '7d' | '30d' | '90d'
export type AnalyticsSourceId = 'all' | 'agent' | 'direct'

export type AnalyticsFilterOption<TId extends string = string> = {
  id: TId
  label: string
}

export type AnalyticsSummaryMetric = {
  id: string
  label: string
  value: string
}

export type AnalyticsTrendPoint = {
  avgRetry: number
  completedGenerations: number
  finalVideos: number
  firstPassVideos: number
  id: string
  label: string
}

export type AnalyticsDistributionItem = {
  count: number
  id: string
  label: string
  tone: 'accent' | 'mint' | 'neutral'
}

export type AnalyticsUserStat = {
  avgDurationSeconds: number
  avgRetry: number
  completed: number
  firstPassRate: number
  id: string
  projects: number
  totalGeneratedDurationSeconds: number
  user: string
}

export type AnalyticsAttentionItem = {
  avgDurationSeconds: number
  avgRetry: number
  id: string
  owner: string
  project: string
  projectId: string
  reason: string
  sessionId: string | null
  source: 'agent' | 'direct'
}

export type GenerationAnalyticsSnapshot = {
  attentionItems: AnalyticsAttentionItem[]
  durationDistribution: AnalyticsDistributionItem[]
  filters: {
    excludeTestData: boolean
    range: AnalyticsRangeId
    source: AnalyticsSourceId
  }
  generatedAt: number
  retryDistribution: AnalyticsDistributionItem[]
  summary: {
    activeUsers: number
    avgDurationSeconds: number
    avgRetry: number
    completedGenerations: number
    effectiveProjects: number
    finalVideos: number
    medianRetry: number
    totalGeneratedDurationSeconds: number
  }
  trendPoints: AnalyticsTrendPoint[]
  userStats: AnalyticsUserStat[]
}

export const ANALYTICS_RANGE_OPTIONS: AnalyticsFilterOption<AnalyticsRangeId>[] = [
  { id: '1d', label: '最近 1 天' },
  { id: '7d', label: '最近 7 天' },
  { id: '30d', label: '最近 30 天' },
  { id: '90d', label: '最近 90 天' },
]

export const ANALYTICS_SOURCE_OPTIONS: AnalyticsFilterOption<AnalyticsSourceId>[] = [
  { id: 'all', label: '全部类型' },
  { id: 'agent', label: 'Agent sessions' },
  { id: 'direct', label: 'Direct projects' },
]
