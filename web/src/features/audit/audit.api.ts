/** 审计报表的三个只读口：筛选范围翻成查询串，汇总用 useQuery，两张明细表用 useInfiniteQuery。 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zAnomaliesOut, zAuditConversationsOut, zSummaryOut } from '@/shared/api/generated/zod.gen'
import { dateRangeBounds, type DateRange } from '@/shared/lib/date-range'

export type Summary = z.output<typeof zSummaryOut>
export type Metrics = Summary['overall']
export type AttemptBucket = Summary['attemptDistribution'][number]
export type ConversationReportsPage = z.output<typeof zAuditConversationsOut>
export type ConversationReport = ConversationReportsPage['items'][number]
export type AnomaliesPage = z.output<typeof zAnomaliesOut>
export type Anomaly = AnomaliesPage['items'][number]
export type AnomalyKind = Anomaly['kind']
export type Bucket = 'day' | 'week' | 'month'

/** 三个标签页共用的筛选：时间范围、人（上游归属用的用户名）与需求单。 */
export interface AuditScope extends DateRange {
  userName: string | null
  taskId: string | null
}

export const DEFAULT_AUDIT_SCOPE: AuditScope = {
  range: '30d',
  since: null,
  until: null,
  taskId: null,
  userName: null,
}

const DAY_MS = 24 * 60 * 60_000
const CONVERSATIONS_PAGE = 20
const ANOMALIES_PAGE = 50

type Window = { since: Date | null; until: Date | null }

/** 时段粒度按窗口跨度定：一个半月内按天，四个月内按周，再长或不限时间按月。 */
export const bucketFor = (scope: DateRange, now: Date = new Date()): Bucket => {
  const { since, until } = dateRangeBounds(scope, now)
  if (since === null) return 'month'
  const days = ((until ?? now).getTime() - since.getTime()) / DAY_MS
  if (days <= 45) return 'day'
  return days <= 120 ? 'week' : 'month'
}

/** 上一期：同样长度、紧挨着往前的一段。不限时间没有上一期。 */
export const previousWindow = (scope: DateRange, now: Date = new Date()): Window | null => {
  const { since, until } = dateRangeBounds(scope, now)
  if (since === null) return null
  const end = until ?? now
  return { since: new Date(since.getTime() * 2 - end.getTime()), until: since }
}

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

const scopeParams = (scope: AuditScope, window: Window): URLSearchParams => {
  const params = new URLSearchParams()
  if (window.since !== null) params.set('since', window.since.toISOString())
  if (window.until !== null) params.set('until', window.until.toISOString())
  if (scope.userName !== null) params.set('userName', scope.userName)
  if (scope.taskId !== null) params.set('taskId', scope.taskId)
  return params
}

/** 汇总的查询串带时段粒度与浏览器时区；now 可注入方便测试。 */
export const summarySearchParams = (
  scope: AuditScope,
  now: Date = new Date(),
  timeZone: string = browserTimeZone(),
): URLSearchParams => {
  const params = scopeParams(scope, dateRangeBounds(scope, now))
  params.set('bucket', bucketFor(scope, now))
  params.set('timezone', timeZone)
  return params
}

/** 上一期与本期同粒度，逐时段叠在趋势图上作对照；没有上一期返回 null。 */
export const previousSearchParams = (
  scope: AuditScope,
  now: Date = new Date(),
  timeZone: string = browserTimeZone(),
): URLSearchParams | null => {
  const window = previousWindow(scope, now)
  if (window === null) return null
  const params = scopeParams(scope, window)
  params.set('bucket', bucketFor(scope, now))
  params.set('timezone', timeZone)
  return params
}

export const conversationsSearchParams = (
  scope: AuditScope,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = scopeParams(scope, dateRangeBounds(scope, now))
  params.set('limit', String(CONVERSATIONS_PAGE))
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const anomaliesSearchParams = (
  scope: AuditScope,
  kinds: readonly AnomalyKind[] | null,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = scopeParams(scope, dateRangeBounds(scope, now))
  params.set('limit', String(ANOMALIES_PAGE))
  for (const kind of kinds ?? []) params.append('kind', kind)
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const auditQueryKeys = {
  all: ['audit'] as const,
  summary: (scope: AuditScope) => ['audit', 'summary', scope] as const,
  previous: (scope: AuditScope) => ['audit', 'previous', scope] as const,
  conversations: (scope: AuditScope) => ['audit', 'conversations', scope] as const,
  anomalies: (scope: AuditScope, kinds: readonly AnomalyKind[] | null) =>
    ['audit', 'anomalies', scope, kinds] as const,
}

const fetchSummary = (params: URLSearchParams, signal: AbortSignal) =>
  apiFetch(`/audit/summary?${params.toString()}`, zSummaryOut, {
    fallbackErrorMessage: '读取审计汇总失败',
    signal,
  })

/** 本期与上一期两份同粒度汇总；上一期只在有界的时间范围下请求。 */
export const useAuditSummary = (scope: AuditScope) => {
  const current = useQuery({
    queryFn: ({ signal }) => fetchSummary(summarySearchParams(scope), signal),
    queryKey: auditQueryKeys.summary(scope),
  })
  const previous = useQuery({
    enabled: previousWindow(scope) !== null,
    queryFn: ({ signal }) =>
      fetchSummary(previousSearchParams(scope) ?? new URLSearchParams(), signal),
    queryKey: auditQueryKeys.previous(scope),
  })
  return { current, previous }
}

/** 缓存留 30 分钟：点进一段对话看上一阵再退回明细表，已展开的分页不该缩回第一页。 */
export const useAuditConversationReports = (scope: AuditScope) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/audit/conversations?${conversationsSearchParams(scope, pageParam).toString()}`,
        zAuditConversationsOut,
        { fallbackErrorMessage: '读取对话明细失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ConversationReportsPage) => last.nextCursor,
    queryKey: auditQueryKeys.conversations(scope),
  })

/** kinds 为空即全部种类；路由层与面板用同一组 kinds 调用时共享同一份缓存。 */
export const useAuditAnomalies = (scope: AuditScope, kinds: readonly AnomalyKind[]) => {
  const filter = kinds.length === 0 ? null : kinds
  return useInfiniteQuery({
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/audit/anomalies?${anomaliesSearchParams(scope, filter, pageParam).toString()}`,
        zAnomaliesOut,
        { fallbackErrorMessage: '读取异常列表失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AnomaliesPage) => last.nextCursor,
    queryKey: auditQueryKeys.anomalies(scope, filter),
  })
}
