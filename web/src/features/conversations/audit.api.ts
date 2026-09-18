/** 治理者的全部对话：筛选条件翻成 /conversations/audit 的查询串，分页交给 useInfiniteQuery。 */

import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zConversationsAuditOut } from '@/shared/api/generated/zod.gen'
import { dateRangeBounds, type DateRange } from '@/shared/lib/date-range'
import { conversationsQueryKeys, type ConversationListState } from './conversations.api'

/** 删没删：缺省只看活着的，deleted 只看属主删掉的，all 都看。 */
export type AuditDeleted = 'live' | 'deleted' | 'all'

/** 时间范围作用在 createdAt 上，与列表排序同一列。 */
export interface AuditFilters extends DateRange {
  state: ConversationListState
  deleted: AuditDeleted
  ownerUserId: string | null
  taskId: string | null
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  deleted: 'live',
  ownerUserId: null,
  range: 'all',
  since: null,
  state: 'all',
  taskId: null,
  until: null,
}

export type AuditPage = z.output<typeof zConversationsAuditOut>

const PAGE_LIMIT = 50

/** 组查询串；now 可注入方便测试。 */
export const auditSearchParams = (
  filters: AuditFilters,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = new URLSearchParams()
  params.set('state', filters.state)
  params.set('deleted', filters.deleted)
  params.set('limit', String(PAGE_LIMIT))
  if (filters.ownerUserId !== null) params.set('ownerUserId', filters.ownerUserId)
  if (filters.taskId !== null) params.set('taskId', filters.taskId)
  const { since, until } = dateRangeBounds(filters, now)
  if (since !== null) params.set('since', since.toISOString())
  if (until !== null) params.set('until', until.toISOString())
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

/**
 * 一页 50 段；两个总数每页都带，取最新一页的即可。
 * 缓存留 30 分钟：治理者点进一段对话看上一阵再退回列表，已展开的分页不该缩回第一页。
 */
export const useAuditConversations = (filters: AuditFilters, enabled: boolean) =>
  useInfiniteQuery({
    enabled,
    gcTime: 30 * 60_000,
    queryFn: ({ pageParam, signal }) => fetchAuditPage(filters, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AuditPage) => last.nextCursor,
    queryKey: conversationsQueryKeys.audit(filters),
  })
