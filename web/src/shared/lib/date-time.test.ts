import { describe, expect, it } from 'vitest'
import { formatDateTime } from './date-time'

describe('formatDateTime', () => {
  it('月日与时分都补足两位', () => {
    // 构造本地时刻，避免用例结果跟着跑测试的机器的时区变。
    const at = new Date(2026, 8, 3, 9, 5)
    expect(formatDateTime(at.toISOString())).toBe('2026-09-03 09:05')
  })

  it('解析不出来就给空串，不画一个 NaN 出来', () => {
    expect(formatDateTime('前天下午')).toBe('')
  })
})
