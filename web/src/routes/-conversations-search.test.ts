import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIT_FILTERS } from '@/features/conversations'
import {
  conversationsSearchSchema,
  filtersFromSearch,
  searchFromFilters,
} from './-conversations-search'

const parse = (search: Record<string, unknown>) => conversationsSearchSchema.parse(search)

describe('全部对话的筛选条件与查询串互转', () => {
  it('默认筛选不写进地址栏', () => {
    expect(searchFromFilters(DEFAULT_AUDIT_FILTERS)).toEqual({})
  })

  it('空查询串就是默认筛选', () => {
    expect(filtersFromSearch(parse({}))).toEqual(DEFAULT_AUDIT_FILTERS)
  })

  it('非默认条件原样往返', () => {
    const filters = {
      deleted: 'all',
      ownerUserId: 'u-1',
      range: 'custom',
      since: '2026-09-01',
      state: 'running',
      taskId: 't-1',
      until: '2026-09-10',
    } as const

    const search = searchFromFilters(filters)

    expect(search).toEqual(filters)
    expect(filtersFromSearch(parse(search))).toEqual(filters)
  })

  it('非自定义范围不留日期，避免地址栏挂着筛不到的旧日期', () => {
    const search = searchFromFilters({
      ...DEFAULT_AUDIT_FILTERS,
      range: '7d',
      since: '2026-09-01',
      until: '2026-09-10',
    })

    expect(search).toEqual({ range: '7d' })
  })

  it('自定义范围缺一端按不限时间处理', () => {
    expect(filtersFromSearch(parse({ range: 'custom', since: '2026-09-01' }))).toEqual(
      DEFAULT_AUDIT_FILTERS,
    )
  })

  it('取值不认识就当没写', () => {
    const search = parse({ deleted: 'maybe', since: '2026/09/01', state: 'paused' })

    expect(search).toEqual({})
    expect(filtersFromSearch(search)).toEqual(DEFAULT_AUDIT_FILTERS)
  })
})
