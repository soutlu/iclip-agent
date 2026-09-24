/** 资料库筛选范围在查询串里的读写：等于默认值的条件不落地址栏，非法取值退回默认。 */

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

export function searchFromScope(scope: LibraryScope): LibrarySearch {
  const q = scope.q.trim()
  return {
    ...dateRangeToSearch(scope, DEFAULT_LIBRARY_SCOPE),
    orientation: scope.orientation ?? undefined,
    q: q === '' ? undefined : q,
    userName: scope.userName ?? undefined,
  }
}
