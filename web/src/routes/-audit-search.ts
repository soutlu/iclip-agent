/** 审计筛选范围与标签页在查询串里的读写：等于默认值的条件不落地址栏，非法取值退回默认。 */

import { z } from 'zod'
import { DEFAULT_AUDIT_SCOPE, type AuditScope } from '@/features/audit'

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

export const auditSearchSchema = z.object({
  range: z.enum(['7d', '30d', 'all', 'custom']).optional().catch(undefined),
  since: z.string().regex(LOCAL_DATE).optional().catch(undefined),
  tab: z.enum(['overview', 'conversations', 'anomalies']).optional().catch(undefined),
  taskId: z.string().min(1).optional().catch(undefined),
  until: z.string().regex(LOCAL_DATE).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
})

export type AuditSearch = z.output<typeof auditSearchSchema>

/**
 * 自定义范围只有选满两端才成立；缺一端的链接按默认范围处理，避免筛选条显示「自定义」却什么都没筛。
 */
export function scopeFromSearch(search: AuditSearch): AuditScope {
  const custom =
    search.range === 'custom' && search.since !== undefined && search.until !== undefined
  const range = search.range === 'custom' && !custom ? undefined : search.range
  return {
    range: range ?? DEFAULT_AUDIT_SCOPE.range,
    since: custom ? (search.since ?? null) : null,
    taskId: search.taskId ?? null,
    until: custom ? (search.until ?? null) : null,
    userName: search.userName ?? null,
  }
}

export function searchFromScope(scope: AuditScope): Omit<AuditSearch, 'tab'> {
  const custom = scope.range === 'custom'
  return {
    range: scope.range === DEFAULT_AUDIT_SCOPE.range ? undefined : scope.range,
    since: custom ? (scope.since ?? undefined) : undefined,
    taskId: scope.taskId ?? undefined,
    until: custom ? (scope.until ?? undefined) : undefined,
    userName: scope.userName ?? undefined,
  }
}
