/** 全部对话的筛选条件在查询串里的读写：等于默认值的条件不落地址栏，非法取值退回默认。 */

import { z } from 'zod'
import { DEFAULT_AUDIT_FILTERS, type AuditFilters } from '@/features/conversations'

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

export const conversationsSearchSchema = z.object({
  deleted: z.enum(['live', 'deleted', 'all']).optional().catch(undefined),
  ownerUserId: z.string().min(1).optional().catch(undefined),
  range: z.enum(['7d', '30d', 'all', 'custom']).optional().catch(undefined),
  since: z.string().regex(LOCAL_DATE).optional().catch(undefined),
  state: z.enum(['all', 'running', 'done']).optional().catch(undefined),
  taskId: z.string().min(1).optional().catch(undefined),
  until: z.string().regex(LOCAL_DATE).optional().catch(undefined),
})

export type ConversationsSearch = z.output<typeof conversationsSearchSchema>

/**
 * 自定义范围只有选满两端才成立；缺一端的链接按不限时间处理，避免筛选条显示「自定义」却什么都没筛。
 */
export function filtersFromSearch(search: ConversationsSearch): AuditFilters {
  const custom =
    search.range === 'custom' && search.since !== undefined && search.until !== undefined
  const range = search.range === 'custom' && !custom ? undefined : search.range
  return {
    deleted: search.deleted ?? DEFAULT_AUDIT_FILTERS.deleted,
    ownerUserId: search.ownerUserId ?? null,
    range: range ?? DEFAULT_AUDIT_FILTERS.range,
    since: custom ? (search.since ?? null) : null,
    state: search.state ?? DEFAULT_AUDIT_FILTERS.state,
    taskId: search.taskId ?? null,
    until: custom ? (search.until ?? null) : null,
  }
}

export function searchFromFilters(filters: AuditFilters): ConversationsSearch {
  const custom = filters.range === 'custom'
  return {
    deleted: filters.deleted === DEFAULT_AUDIT_FILTERS.deleted ? undefined : filters.deleted,
    ownerUserId: filters.ownerUserId ?? undefined,
    range: filters.range === DEFAULT_AUDIT_FILTERS.range ? undefined : filters.range,
    since: custom ? (filters.since ?? undefined) : undefined,
    state: filters.state === DEFAULT_AUDIT_FILTERS.state ? undefined : filters.state,
    taskId: filters.taskId ?? undefined,
    until: custom ? (filters.until ?? undefined) : undefined,
  }
}
