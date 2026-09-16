import { describe, expect, it } from 'vitest'
import {
  anomaliesSearchParams,
  bucketFor,
  conversationsSearchParams,
  DEFAULT_AUDIT_SCOPE,
  previousSearchParams,
  previousWindow,
  summarySearchParams,
  type AuditScope,
} from './audit.api'

const NOW = new Date(2026, 8, 15, 20, 0, 0)
const DAY_MS = 24 * 60 * 60_000

const scopeOf = (patch: Partial<AuditScope>): AuditScope => ({ ...DEFAULT_AUDIT_SCOPE, ...patch })

describe('时段粒度', () => {
  it.each([
    { scope: scopeOf({ range: '7d' }), bucket: 'day' },
    { scope: scopeOf({ range: '30d' }), bucket: 'week' },
    {
      scope: scopeOf({ range: 'custom', since: '2026-03-01', until: '2026-09-01' }),
      bucket: 'month',
    },
    { scope: scopeOf({ range: 'all' }), bucket: 'month' },
  ] as const)('$scope.range → $bucket', ({ scope, bucket }) => {
    expect(bucketFor(scope, NOW)).toBe(bucket)
  })
})

describe('汇总查询串', () => {
  it('带本期窗口、粒度与浏览器时区，人和需求单按需带', () => {
    const params = summarySearchParams(
      scopeOf({ range: '7d', taskId: 'task-1', userName: 'Shan.Hu' }),
      NOW,
      'Asia/Shanghai',
    )

    expect(params.get('since')).toBe(new Date(NOW.getTime() - 7 * DAY_MS).toISOString())
    expect(params.get('until')).toBeNull()
    expect(params.get('bucket')).toBe('day')
    expect(params.get('timezone')).toBe('Asia/Shanghai')
    expect(params.get('userName')).toBe('Shan.Hu')
    expect(params.get('taskId')).toBe('task-1')
  })

  it('不限时间就不带窗口', () => {
    const params = summarySearchParams(scopeOf({ range: 'all' }), NOW, 'UTC')
    expect(params.has('since')).toBe(false)
    expect(params.has('until')).toBe(false)
  })
})

describe('上一期', () => {
  it('是同样长度、紧挨着往前的一段，不切时段', () => {
    const window = previousWindow(scopeOf({ range: '30d' }), NOW)
    expect(window).toEqual({
      since: new Date(NOW.getTime() - 60 * DAY_MS),
      until: new Date(NOW.getTime() - 30 * DAY_MS),
    })
    const params = previousSearchParams(scopeOf({ range: '30d' }), NOW)
    expect(params?.has('bucket')).toBe(false)
  })

  it('自定义区间照区间长度往前推', () => {
    const window = previousWindow(
      scopeOf({ range: 'custom', since: '2026-09-08', until: '2026-09-14' }),
      NOW,
    )
    expect(window?.until).toEqual(new Date(2026, 8, 8, 0, 0, 0, 0))
    expect(window?.since).toEqual(new Date(2026, 8, 1, 0, 0, 0, 1))
  })

  it('不限时间没有上一期', () => {
    expect(previousWindow(scopeOf({ range: 'all' }), NOW)).toBeNull()
    expect(previousSearchParams(scopeOf({ range: 'all' }), NOW)).toBeNull()
  })
})

describe('明细与异常查询串', () => {
  it('对话明细带页长与游标', () => {
    const params = conversationsSearchParams(scopeOf({ range: 'all' }), 'cursor-1', NOW)
    expect(params.get('limit')).toBe('20')
    expect(params.get('cursor')).toBe('cursor-1')
  })

  it('异常把每个种类重复成一个 kind，不筛就不带', () => {
    const params = anomaliesSearchParams(scopeOf({ range: 'all' }), ['retry', 'idle'], null, NOW)
    expect(params.getAll('kind')).toEqual(['retry', 'idle'])
    expect(params.has('cursor')).toBe(false)
    expect(anomaliesSearchParams(scopeOf({}), null, null, NOW).has('kind')).toBe(false)
  })
})
