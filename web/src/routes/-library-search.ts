/** 资料库的查询串：筛选范围与打开着的那条详情。等于默认值的条件不落地址栏，非法取值退回默认。 */

import { z } from 'zod'
import { DEFAULT_LIBRARY_SCOPE, type LibraryScope } from '@/features/library'
import {
  dateRangeFromSearch,
  dateRangeSearchFields,
  dateRangeToSearch,
} from '@/shared/lib/date-range'

export const librarySearchSchema = z.object({
  ...dateRangeSearchFields,
  orientation: z.enum(['portrait', 'landscape']).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
  /** 打开着详情的那张卡；分享出去的链接也靠它直达。 */
  video: z.uuid().optional().catch(undefined),
})

export type LibrarySearch = z.output<typeof librarySearchSchema>

export function scopeFromSearch(search: LibrarySearch): LibraryScope {
  return {
    ...dateRangeFromSearch(search, DEFAULT_LIBRARY_SCOPE),
    orientation: search.orientation ?? null,
    q: search.q ?? '',
    userName: search.userName ?? null,
  }
}

/** 只写筛选范围；改筛选时详情随之关掉。 */
export function searchFromScope(scope: LibraryScope): LibrarySearch {
  const q = scope.q.trim()
  return {
    ...dateRangeToSearch(scope, DEFAULT_LIBRARY_SCOPE),
    orientation: scope.orientation ?? undefined,
    q: q === '' ? undefined : q,
    userName: scope.userName ?? undefined,
  }
}
