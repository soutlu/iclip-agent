import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import type { AuditFilters } from '../audit.api'
import { AuditDatePicker } from './audit-date-picker'

type AuditDateValue = Pick<AuditFilters, 'range' | 'since' | 'until'>

const UNFILTERED: AuditDateValue = { range: 'all', since: null, until: null }

const renderPicker = async (value: AuditDateValue = UNFILTERED) => {
  const applied: AuditDateValue[] = []
  await renderWithProviders(
    <AuditDatePicker onChange={(next) => applied.push(next)} value={value} />,
  )
  return { applied, user: userEvent.setup() }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 12, 12))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AuditDatePicker', () => {
  it('自定义先在本地选起点，跨月选满终点后才应用区间', async () => {
    const { applied, user } = await renderPicker()

    await user.click(screen.getByRole('radio', { name: '自定义' }))
    expect(applied).toEqual([])
    await user.click(screen.getByRole('button', { name: '2026年9月30日' }))
    expect(applied).toEqual([])

    await user.click(screen.getByRole('button', { name: '下个月' }))
    await user.click(screen.getByRole('button', { name: '2026年10月2日' }))

    expect(applied).toEqual([{ range: 'custom', since: '2026-09-30', until: '2026-10-02' }])
  })

  it.each([
    { first: 12, second: 8, since: '2026-09-08', until: '2026-09-12' },
    { first: 8, second: 8, since: '2026-09-08', until: '2026-09-08' },
  ])('接受逆序或同日区间：$first 日到 $second 日', async ({ first, second, since, until }) => {
    const { applied, user } = await renderPicker()
    await user.click(screen.getByRole('radio', { name: '自定义' }))

    await user.click(screen.getByRole('button', { name: `2026年9月${first}日` }))
    await user.click(screen.getByRole('button', { name: `2026年9月${second}日` }))

    expect(applied).toEqual([{ range: 'custom', since, until }])
  })

  it.each([
    { label: '近 7 天', range: '7d' },
    { label: '近 30 天', range: '30d' },
  ] as const)('选择 $label 时直接应用，并清除自定义日期', async ({ label, range }) => {
    const { applied, user } = await renderPicker({
      range: 'custom',
      since: '2026-09-08',
      until: '2026-09-12',
    })

    await user.click(screen.getByRole('radio', { name: label }))

    expect(applied).toEqual([{ range, since: null, until: null }])
  })

  it.each([
    { label: '近 7 天', value: { range: '7d', since: null, until: null } },
    { label: '近 30 天', value: { range: '30d', since: null, until: null } },
    {
      label: '自定义',
      value: { range: 'custom', since: '2026-09-08', until: '2026-09-12' },
    },
  ] as const)('再次点击已生效的 $label 清除筛选', async ({ label, value }) => {
    const { applied, user } = await renderPicker(value)

    await user.click(screen.getByRole('radio', { name: label }))

    expect(applied).toEqual([UNFILTERED])
  })

  it('取消尚未提交的自定义选择时保留原有范围', async () => {
    const { applied, user } = await renderPicker({ range: '7d', since: null, until: null })
    await user.click(screen.getByRole('radio', { name: '自定义' }))
    await user.click(screen.getByRole('button', { name: '2026年9月8日' }))

    await user.click(screen.getByRole('radio', { name: '自定义' }))

    expect(applied).toEqual([])
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '近 7 天' })).toBeChecked()
  })

  it('自定义尚未提交时仍可再次点已生效的快捷项清除筛选', async () => {
    const { applied, user } = await renderPicker({ range: '7d', since: null, until: null })
    await user.click(screen.getByRole('radio', { name: '自定义' }))
    await user.click(screen.getByRole('button', { name: '2026年9月8日' }))

    await user.click(screen.getByRole('radio', { name: '近 7 天' }))

    expect(applied).toEqual([UNFILTERED])
  })

  it('已生效的区间打开时显示选中的每一天，修改起点仍不立即应用', async () => {
    const { applied, user } = await renderPicker({
      range: 'custom',
      since: '2026-09-08',
      until: '2026-09-12',
    })

    expect(screen.getAllByRole('gridcell', { selected: true })).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: '2026年9月10日' }))

    expect(applied).toEqual([])
    expect(screen.getAllByRole('gridcell', { selected: true })).toHaveLength(1)
  })

  it('键盘可跨月、跨闰年和移动到周首尾，Enter 与空格完成区间', async () => {
    vi.setSystemTime(new Date(2024, 0, 31, 12))
    const { applied, user } = await renderPicker()
    await user.click(screen.getByRole('radio', { name: '自定义' }))
    expect(screen.getByRole('button', { name: '2024年1月31日' })).toHaveFocus()

    await user.keyboard('{PageDown}')
    expect(screen.getByRole('button', { name: '2024年2月29日' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: '2024年3月1日' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('button', { name: '2024年2月29日' })).toHaveFocus()
    await user.keyboard('{Shift>}{PageDown}{/Shift}')
    expect(screen.getByRole('button', { name: '2025年2月28日' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('button', { name: '2025年2月24日' })).toHaveFocus()
    await user.keyboard('{End}{Enter}')
    expect(screen.getByRole('button', { name: '2025年3月2日' })).toHaveFocus()
    expect(applied).toEqual([])

    await user.keyboard('{ArrowDown} ')

    expect(applied).toEqual([{ range: 'custom', since: '2025-03-02', until: '2025-03-09' }])
  })

  it('翻月按钮保留焦点，Tab 回到该月唯一可聚焦日期', async () => {
    vi.setSystemTime(new Date(2024, 0, 31, 12))
    const { user } = await renderPicker()
    await user.click(screen.getByRole('radio', { name: '自定义' }))

    await user.click(screen.getByRole('button', { name: '下个月' }))
    expect(screen.getByRole('button', { name: '下个月' })).toHaveFocus()
    await user.tab()

    expect(screen.getByRole('button', { name: '2024年2月29日' })).toHaveFocus()
    await user.keyboard('{PageUp}{ArrowUp}')
    expect(screen.getByRole('button', { name: '2024年1月22日' })).toHaveFocus()
  })
})
