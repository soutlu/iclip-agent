/** 治理者的全部对话：筛选条件翻成 /conversations/audit 的查询串，分页交给 useInfiniteQuery。 */

import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zConversationsAuditOut } from '@/shared/api/generated/zod.gen'
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

/** 把 YYYY-MM-DD 当本地日期读；endOfDay 取当天最后一毫秒。裸日期直接发过去会被当成 UTC 零点，差八小时。 */
const localDay = (date: string, endOfDay: boolean): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const value = new Date(year, month - 1, day)
  // Date 会把 13 月、40 日往后滚成合法日期，往回对一次才算真日期。
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) {
    return null
  }
  if (endOfDay) value.setHours(23, 59, 59, 999)
  return value
}

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
    const since = filters.since === null ? null : localDay(filters.since, false)
    const until = filters.until === null ? null : localDay(filters.until, true)
    if (since !== null) params.set('since', since.toISOString())
    if (until !== null) params.set('until', until.toISOString())
  }
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

const fetchAuditPage = (filters: AuditFilters, cursor: string | null): Promise<AuditPage> =>
  apiFetch(
    `/conversations/audit?${auditSearchParams(filters, cursor).toString()}`,
    zConversationsAuditOut,
    {
      fallbackErrorMessage: '读取全部对话失败',
    },
  )

/** 一页 50 段；两个总数每页都带，取最新一页的即可。 */
export const useAuditConversations = (filters: AuditFilters, enabled: boolean) =>
  useInfiniteQuery({
    enabled,
    queryFn: ({ pageParam }) => fetchAuditPage(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AuditPage) => last.nextCursor,
    queryKey: conversationsQueryKeys.audit(filters),
  })
