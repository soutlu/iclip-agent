import { describe, expect, it } from 'vitest'
import { auditSearchParams, DEFAULT_AUDIT_FILTERS } from './audit.api'

const NOW = new Date('2026-09-12T08:00:00Z')

describe('auditSearchParams', () => {
  it('默认筛选只带 state 与 limit，全部时间不带 since / until', () => {
    const params = auditSearchParams(DEFAULT_AUDIT_FILTERS, null, NOW)
    expect([...params.keys()].sort()).toEqual(['limit', 'state'])
    expect(params.get('state')).toBe('all')
  })

  it.each([
    ['7d', '2026-09-05T08:00:00.000Z'],
    ['30d', '2026-08-13T08:00:00.000Z'],
  ] as const)('近 %s 从此刻往前推，只有 since', (range, since) => {
    const params = auditSearchParams({ ...DEFAULT_AUDIT_FILTERS, range }, null, NOW)
    expect(params.get('since')).toBe(since)
    expect(params.has('until')).toBe(false)
  })

  it('自定义日期按本地零点与当天最后一毫秒发 ISO，不把裸日期当 UTC', () => {
    const params = auditSearchParams(
      { ...DEFAULT_AUDIT_FILTERS, range: 'custom', since: '2026-09-01', until: '2026-09-03' },
      null,
      NOW,
    )
    expect(params.get('since')).toBe(new Date(2026, 8, 1).toISOString())
    expect(params.get('until')).toBe(new Date(2026, 8, 3, 23, 59, 59, 999).toISOString())
  })

  it('自定义只填一头时另一头不带；填坏的日期忽略', () => {
    const open = auditSearchParams(
      { ...DEFAULT_AUDIT_FILTERS, range: 'custom', since: '2026-09-01', until: null },
      null,
      NOW,
    )
    expect(open.has('until')).toBe(false)
    const broken = auditSearchParams(
      { ...DEFAULT_AUDIT_FILTERS, range: 'custom', since: '昨天', until: '2026-13-40' },
      null,
      NOW,
    )
    expect(broken.has('since')).toBe(false)
    expect(broken.has('until')).toBe(false)
  })

  it('属主、需求单、状态与游标原样带上', () => {
    const params = auditSearchParams(
      {
        ...DEFAULT_AUDIT_FILTERS,
        ownerUserId: 'u-1',
        state: 'running',
        taskId: 't-1',
      },
      'cursor-2',
      NOW,
    )
    expect(params.get('ownerUserId')).toBe('u-1')
    expect(params.get('taskId')).toBe('t-1')
    expect(params.get('state')).toBe('running')
    expect(params.get('cursor')).toBe('cursor-2')
  })
})
