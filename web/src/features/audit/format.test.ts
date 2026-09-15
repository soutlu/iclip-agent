import { describe, expect, it } from 'vitest'
import {
  compareWithPrevious,
  formatDuration,
  formatPeriodLabel,
  formatRate,
  formatTimes,
  formatTokens,
} from './format'

describe('审计数字的人话', () => {
  it.each([
    { seconds: null, text: '—' },
    { seconds: 42, text: '42 秒' },
    { seconds: 1500, text: '25 分' },
    { seconds: 4800, text: '1.3 小时' },
    { seconds: 200_000, text: '2.3 天' },
  ])('$seconds 秒写成 $text', ({ seconds, text }) => {
    expect(formatDuration(seconds)).toBe(text)
  })

  it.each([
    { value: 950, text: '950' },
    { value: 12_345, text: '1.2 万' },
    { value: 2_500_000, text: '250 万' },
    { value: 340_000_000, text: '3.4 亿' },
  ])('$value token 写成 $text', ({ value, text }) => {
    expect(formatTokens(value)).toBe(text)
  })

  it('比率与次数保留一位小数，缺数据给横线', () => {
    expect(formatRate(0.625)).toBe('62.5%')
    expect(formatRate(null)).toBe('—')
    expect(formatTimes(1.4)).toBe('1.4 次')
    expect(formatTimes(null)).toBe('—')
  })
})

describe('较上期', () => {
  it('涨了算好，越低越好的指标涨了算坏', () => {
    expect(compareWithPrevious(12, 10)).toEqual({ text: '+20%', tone: 'better' })
    expect(compareWithPrevious(12, 10, { lowerIsBetter: true })).toEqual({
      text: '+20%',
      tone: 'worse',
    })
    expect(compareWithPrevious(9, 10, { lowerIsBetter: true })).toEqual({
      text: '-10%',
      tone: 'better',
    })
  })

  it('持平、上一期为零或缺数据都不给变化', () => {
    expect(compareWithPrevious(10, 10)).toEqual({ text: '0%', tone: 'flat' })
    expect(compareWithPrevious(10, 0)).toBeNull()
    expect(compareWithPrevious(null, 10)).toBeNull()
    expect(compareWithPrevious(10, undefined)).toBeNull()
  })
})

describe('时段刻度', () => {
  const start = new Date(2026, 8, 7).toISOString()

  it.each([
    { bucket: 'day', text: '9/7' },
    { bucket: 'week', text: '9/7 起' },
    { bucket: 'month', text: '2026/9' },
  ] as const)('按 $bucket 写成 $text', ({ bucket, text }) => {
    expect(formatPeriodLabel(start, bucket)).toBe(text)
  })
})
