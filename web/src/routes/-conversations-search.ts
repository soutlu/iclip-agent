/** 全部对话的筛选条件在查询串里的读写：等于默认值的条件不落地址栏，非法取值退回默认。 */

import { z } from 'zod'
import {
  auditDeletedSchema,
  conversationListStateSchema,
  DEFAULT_AUDIT_FILTERS,
  type AuditFilters,
} from '@/features/conversations'
import {
  dateRangeFromSearch,
  dateRangeSearchFields,
  dateRangeToSearch,
} from '@/shared/lib/date-range'

export const conversationsSearchSchema = z.object({
  ...dateRangeSearchFields,
  deleted: auditDeletedSchema.optional().catch(undefined),
  ownerUserId: z.string().min(1).optional().catch(undefined),
  state: conversationListStateSchema.optional().catch(undefined),
  taskId: z.string().min(1).optional().catch(undefined),
})

export type ConversationsSearch = z.output<typeof conversationsSearchSchema>

export function filtersFromSearch(search: ConversationsSearch): AuditFilters {
  return {
    ...dateRangeFromSearch(search, DEFAULT_AUDIT_FILTERS),
    deleted: search.deleted ?? DEFAULT_AUDIT_FILTERS.deleted,
    ownerUserId: search.ownerUserId ?? null,
    state: search.state ?? DEFAULT_AUDIT_FILTERS.state,
    taskId: search.taskId ?? null,
  }
}

export function searchFromFilters(filters: AuditFilters): ConversationsSearch {
  return {
    ...dateRangeToSearch(filters, DEFAULT_AUDIT_FILTERS),
    deleted: filters.deleted === DEFAULT_AUDIT_FILTERS.deleted ? undefined : filters.deleted,
    ownerUserId: filters.ownerUserId ?? undefined,
    state: filters.state === DEFAULT_AUDIT_FILTERS.state ? undefined : filters.state,
    taskId: filters.taskId ?? undefined,
  }
}
