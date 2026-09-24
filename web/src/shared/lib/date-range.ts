/** 筛选用的时间范围：快捷预设或一段本地日期区间，及其与接口时间戳、查询串之间的换算。 */

import { z } from 'zod'

/** 快捷预设往前数的天数；预设取值、标签、查询串取值与日历上的预设 chip 都从这张表推，按表内顺序排。 */
const PRESET_DAYS = { '7d': 7, '30d': 30 } as const

type DateRangePresetDays = keyof typeof PRESET_DAYS

/** 带天数的快捷预设，按表内顺序。Object.keys 只给 string[]，键的类型由上面的字面量表担保。 */
export const DATE_RANGE_DAY_PRESETS = Object.keys(PRESET_DAYS) as readonly DateRangePresetDays[]

const DATE_RANGE_PRESETS = [...DATE_RANGE_DAY_PRESETS, 'all', 'custom'] as const

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number]

export const isDateRangeDayPreset = (value: string): value is DateRangePresetDays =>
  Object.hasOwn(PRESET_DAYS, value)

export interface DateRange {
  range: DateRangePreset
  /** 本地日期，YYYY-MM-DD；只在 range 为 custom 时生效。 */
  since: string | null
  until: string | null
}

export const UNBOUNDED_RANGE: DateRange = { range: 'all', since: null, until: null }

/** 快捷预设往前数的天数；非预设返回 null，供日历高亮这段区间。 */
export function dateRangePresetDays(range: DateRangePreset): number | null {
  return isDateRangeDayPreset(range) ? PRESET_DAYS[range] : null
}

const DAY_MS = 24 * 60 * 60_000

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * 范围两端的时刻：预设按此刻往前数 N×24 小时；自定义包含结束日全天，按用户本地时区算。
 * 日历上的预设高亮是含今天在内的 N 个整日，与这里的起点差一个部分日，只是展示口径。
 */
export function dateRangeBounds(
  value: DateRange,
  now: Date = new Date(),
): { since: Date | null; until: Date | null } {
  if (isDateRangeDayPreset(value.range)) {
    return { since: new Date(now.getTime() - PRESET_DAYS[value.range] * DAY_MS), until: null }
  }
  if (value.range === 'custom') {
    const since = value.since === null ? null : parseLocalDate(value.since)
    const until = value.until === null ? null : parseLocalDate(value.until)
    until?.setHours(23, 59, 59, 999)
    return { since, until }
  }
  return { since: null, until: null }
}

/** 按本地零点解析 YYYY-MM-DD；拒绝 Date 自动进位产生的无效日期。 */
export function parseLocalDate(date: string): Date | null {
  const match = LOCAL_DATE.exec(date)
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
export function dateRangeLabel(value: DateRange): string {
  if (value.range === 'all') return '时间'
  if (isDateRangeDayPreset(value.range)) return `近 ${PRESET_DAYS[value.range]} 天`

  const since = value.since === null ? null : parseLocalDate(value.since)
  const until = value.until === null ? null : parseLocalDate(value.until)
  if (since === null || until === null) return '自定义'

  const currentYear = new Date().getFullYear()
  const includeYear = since.getFullYear() !== currentYear || until.getFullYear() !== currentYear
  const format = (date: Date) =>
    `${includeYear ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日`
  return since.getTime() === until.getTime() ? format(since) : `${format(since)} — ${format(until)}`
}

/** 时间范围在查询串里的三个字段，拼进各页自己的 search schema。 */
export const dateRangeSearchFields = {
  range: z.enum(DATE_RANGE_PRESETS).optional().catch(undefined),
  since: z.string().regex(LOCAL_DATE).optional().catch(undefined),
  until: z.string().regex(LOCAL_DATE).optional().catch(undefined),
}

export type DateRangeSearch = {
  range?: DateRangePreset | undefined
  since?: string | undefined
  until?: string | undefined
}

/**
 * 自定义范围只有选满两端才成立；缺一端的链接退回 fallback 的范围，避免筛选条显示「自定义」却什么都没筛。
 * fallback 只取 range，传各页的默认筛选即可。
 */
export function dateRangeFromSearch(search: DateRangeSearch, fallback: DateRange): DateRange {
  const custom =
    search.range === 'custom' && search.since !== undefined && search.until !== undefined
  const range = search.range === 'custom' && !custom ? undefined : search.range
  return {
    range: range ?? fallback.range,
    since: custom ? (search.since ?? null) : null,
    until: custom ? (search.until ?? null) : null,
  }
}

/** 等于 fallback 的范围不落地址栏；非自定义范围不留日期，免得地址栏挂着筛不到的旧日期。 */
export function dateRangeToSearch(value: DateRange, fallback: DateRange): DateRangeSearch {
  const custom = value.range === 'custom'
  return {
    range: value.range === fallback.range ? undefined : value.range,
    since: custom ? (value.since ?? undefined) : undefined,
    until: custom ? (value.until ?? undefined) : undefined,
  }
}
