import type { AuditFilters } from './audit.api'

type AuditDateValue = Pick<AuditFilters, 'range' | 'since' | 'until'>

/** 按本地零点解析 YYYY-MM-DD；拒绝 Date 自动进位产生的无效日期。 */
export function parseLocalDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) return null

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const value = new Date(0)
  value.setHours(0, 0, 0, 0)
  // setFullYear 保留 0000–0099 年；Date(year, month, day) 会把它们当成 1900 年代。
  value.setFullYear(year, month - 1, day)
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) {
    return null
  }
  return value
}

/** 输出本地日期，不经 UTC 转换，避免筛选区间前后偏移一天。 */
export function formatLocalDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

/** 筛选触发器与日历共用的日期说明；非当年或跨年区间保留年份。 */
export function auditDateLabel(value: AuditDateValue): string {
  if (value.range === 'all') return '时间'
  if (value.range === '7d') return '近 7 天'
  if (value.range === '30d') return '近 30 天'

  const since = value.since === null ? null : parseLocalDate(value.since)
  const until = value.until === null ? null : parseLocalDate(value.until)
  if (since === null || until === null) return '自定义'

  const currentYear = new Date().getFullYear()
  const includeYear = since.getFullYear() !== currentYear || until.getFullYear() !== currentYear
  const format = (date: Date) =>
    `${includeYear ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日`
  return since.getTime() === until.getTime() ? format(since) : `${format(since)} — ${format(until)}`
}
