/** 治理者的全部对话：筛选条件翻成 /conversations/audit 的查询串，分页交给 useInfiniteQuery。 */

import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zConversationsAuditOut } from '@/shared/api/generated/zod.gen'
import { parseLocalDate } from './audit-dates'
import { conversationsQueryKeys, type ConversationListState } from './conversations.api'

/** 时间筛选作用在 updatedAt 上；custom 时读 since / until 两个本地日期。 */
export type AuditRange = '7d' | '30d' | 'all' | 'custom'

export interface AuditFilters {
  state: ConversationListState
  ownerUserId: string | null
  taskId: string | null
  range: AuditRange
  /** 本地日期，YYYY-MM-DD；只在 range 为 custom 时生效。 */
  since: string | null
  until: string | null
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  ownerUserId: null,
  range: 'all',
  since: null,
  state: 'all',
  taskId: null,
  until: null,
}

export type AuditPage = z.output<typeof zConversationsAuditOut>

const PAGE_LIMIT = 50
const DAY_MS = 24 * 60 * 60_000

/** 组查询串；now 可注入方便测试。 */
export const auditSearchParams = (
  filters: AuditFilters,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = new URLSearchParams()
  params.set('state', filters.state)
  params.set('limit', String(PAGE_LIMIT))
  if (filters.ownerUserId !== null) params.set('ownerUserId', filters.ownerUserId)
  if (filters.taskId !== null) params.set('taskId', filters.taskId)
  if (filters.range === '7d' || filters.range === '30d') {
    const days = filters.range === '7d' ? 7 : 30
    params.set('since', new Date(now.getTime() - days * DAY_MS).toISOString())
  } else if (filters.range === 'custom') {
    const since = filters.since === null ? null : parseLocalDate(filters.since)
    const until = filters.until === null ? null : parseLocalDate(filters.until)
    // 日期范围包含结束日全天，按用户的本地时区转成接口时间戳。
    until?.setHours(23, 59, 59, 999)
    if (since !== null) params.set('since', since.toISOString())
    if (until !== null) params.set('until', until.toISOString())
  }
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

const fetchAuditPage = (
  filters: AuditFilters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<AuditPage> =>
  apiFetch(
    `/conversations/audit?${auditSearchParams(filters, cursor).toString()}`,
    zConversationsAuditOut,
    {
      fallbackErrorMessage: '读取全部对话失败',
      signal,
    },
  )

/** 一页 50 段；两个总数每页都带，取最新一页的即可。 */
export const useAuditConversations = (filters: AuditFilters, enabled: boolean) =>
  useInfiniteQuery({
    enabled,
    queryFn: ({ pageParam, signal }) => fetchAuditPage(filters, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AuditPage) => last.nextCursor,
    queryKey: conversationsQueryKeys.audit(filters),
  })
