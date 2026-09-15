/** 把接口里的秒、token、比率翻成给人读的字；页面上不出现原始秒数与字段名。 */

import type { Bucket } from './audit.api'

export const EMPTY = '—'

export const formatCount = (value: number): string => value.toLocaleString('zh-CN')

/** 一万以上用「万」，一亿以上用「亿」；小数只在数字还小时保留一位。 */
export const formatTokens = (value: number): string => {
  if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 0 : 1)} 亿`
  if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)} 万`
  return formatCount(value)
}

export const formatRate = (ratio: number | null): string =>
  ratio === null ? EMPTY : `${(ratio * 100).toFixed(1)}%`

export const formatTimes = (value: number | null): string =>
  value === null ? EMPTY : `${value.toFixed(1)} 次`

/** 一分钟内说秒，一小时内说分，一天内说小时，再长说天。 */
export const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return EMPTY
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} 小时`
  return `${(seconds / 86_400).toFixed(1)} 天`
}

export type DeltaTone = 'better' | 'worse' | 'flat'

export interface Delta {
  /** 相对上一期的变化，如 +12%；上一期为零或缺数据时没有。 */
  text: string
  tone: DeltaTone
}

/** 与上一期比。lowerIsBetter 的指标（每镜次数、周期）降了才算好。 */
export const compareWithPrevious = (
  current: number | null,
  previous: number | null | undefined,
  { lowerIsBetter = false } = {},
): Delta | null => {
  if (current === null || previous === null || previous === undefined || previous === 0) {
    return null
  }
  const ratio = (current - previous) / previous
  const percent = Math.round(ratio * 100)
  const text = `${percent > 0 ? '+' : ''}${percent}%`
  if (percent === 0) return { text, tone: 'flat' }
  const improved = lowerIsBetter ? ratio < 0 : ratio > 0
  return { text, tone: improved ? 'better' : 'worse' }
}

/** 时段刻度：按天 9/12，按周 9/8 起，按月 2026/9。 */
export const formatPeriodLabel = (iso: string, bucket: Bucket): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const month = at.getMonth() + 1
  if (bucket === 'month') return `${at.getFullYear()}/${month}`
  const day = `${month}/${at.getDate()}`
  return bucket === 'week' ? `${day} 起` : day
}
