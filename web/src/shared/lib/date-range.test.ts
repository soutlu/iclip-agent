import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  dateRangeBounds,
  dateRangeFromSearch,
  dateRangeSearchFields,
  dateRangeToSearch,
  formatLocalDate,
  parseLocalDate,
  UNBOUNDED_RANGE,
  type DateRange,
} from './date-range'

describe('时间范围换算', () => {
  const now = new Date(2026, 8, 12, 20, 0, 0)

  it.each([
    { range: '7d', days: 7 },
    { range: '30d', days: 30 },
  ] as const)('$range 从此刻往前数 $days 天，不设上界', ({ range, days }) => {
    const bounds = dateRangeBounds({ range, since: null, until: null }, now)
    expect(bounds.until).toBeNull()
    expect(bounds.since?.getTime()).toBe(now.getTime() - days * 24 * 60 * 60_000)
  })

  it('自定义区间按本地日期取起点零点与结束日最后一毫秒', () => {
    const bounds = dateRangeBounds({ range: 'custom', since: '2026-09-08', until: '2026-09-12' })
    expect(bounds.since).toEqual(new Date(2026, 8, 8, 0, 0, 0, 0))
    expect(bounds.until).toEqual(new Date(2026, 8, 12, 23, 59, 59, 999))
  })

  it('不限时间与只选了一端的自定义都不设那一端', () => {
    expect(dateRangeBounds({ range: 'all', since: null, until: null })).toEqual({
      since: null,
      until: null,
    })
    expect(dateRangeBounds({ range: 'custom', since: '2026-09-08', until: null }).until).toBeNull()
  })
})

describe('本地日期', () => {
  it.each(['2024-02-29', '2026-03-08', '2026-11-01', '0099-12-31'])(
    '解析并格式化 %s 时保留本地年月日与零点',
    (input) => {
      const date = parseLocalDate(input)
      expect(date).not.toBeNull()
      if (date === null) throw new Error('测试日期必须可以解析')
      expect(formatLocalDate(date)).toBe(input)
      expect([
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds(),
      ]).toEqual([0, 0, 0, 0])
    },
  )

  it.each([
    '2026-02-29',
    '2024-02-30',
    '2026-00-01',
    '2026-01-00',
    '2026-1-01',
    '2026-09-12T00:00:00Z',
  ])('拒绝格式错误或超出日历范围的 %s', (input) => {
    expect(parseLocalDate(input)).toBeNull()
  })
})

describe('时间范围与查询串互转', () => {
  const schema = z.object(dateRangeSearchFields)
  const parse = (search: Record<string, unknown>) => schema.parse(search)
  const DEFAULT_30D: DateRange = { range: '30d', since: null, until: null }

  it.each(['7d', '30d', 'all', 'custom'] as const)('%s 原样往返', (range) => {
    const value: DateRange =
      range === 'custom'
        ? { range, since: '2026-09-01', until: '2026-09-10' }
        : { range, since: null, until: null }

    const search = dateRangeToSearch(value, UNBOUNDED_RANGE)

    expect(dateRangeFromSearch(parse(search), UNBOUNDED_RANGE)).toEqual(value)
  })

  it('等于 fallback 的范围不落地址栏，空查询串就是 fallback', () => {
    expect(dateRangeToSearch(DEFAULT_30D, DEFAULT_30D)).toEqual({})
    expect(dateRangeFromSearch(parse({}), DEFAULT_30D)).toEqual(DEFAULT_30D)
    expect(dateRangeFromSearch(parse({}), UNBOUNDED_RANGE)).toEqual(UNBOUNDED_RANGE)
  })

  it('非自定义范围不留日期', () => {
    const search = dateRangeToSearch(
      { range: '7d', since: '2026-09-01', until: '2026-09-10' },
      UNBOUNDED_RANGE,
    )

    expect(search).toEqual({ range: '7d' })
  })

  it('自定义范围缺一端退回 fallback', () => {
    expect(
      dateRangeFromSearch(parse({ range: 'custom', since: '2026-09-01' }), DEFAULT_30D),
    ).toEqual(DEFAULT_30D)
  })

  it('取值不认识就当没写', () => {
    const search = parse({ range: '3d', since: '2026/09/01', until: '昨天' })

    expect(search).toEqual({})
    expect(dateRangeFromSearch(search, DEFAULT_30D)).toEqual(DEFAULT_30D)
  })
})
