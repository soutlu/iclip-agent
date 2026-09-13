import { describe, expect, it } from 'vitest'
import { formatLocalDate, parseLocalDate } from './audit-dates'

describe('本地审计日期', () => {
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
