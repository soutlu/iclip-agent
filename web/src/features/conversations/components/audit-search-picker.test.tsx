import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { AuditSearchPicker } from './audit-search-picker'

const USERS = [
  { id: 'tester', label: '测试用户' },
  { id: 'wang', label: '小王' },
  { id: 'governor', label: '治理者' },
]
const TASKS = [
  { id: 'linen', label: '夏季亚麻系列' },
  { id: 'autumn', label: '秋季新品' },
  { id: 'tiktok', label: 'TikTok 产品展示' },
]

function PickerControls({
  error,
  label = '用户',
  options = USERS,
  initialValue = 'wang',
  selectedLabel,
}: {
  error?: string
  label?: string
  options?: readonly { id: string; label: string }[]
  initialValue?: string | null
  selectedLabel?: string | undefined
}) {
  const [value, setValue] = useState(initialValue)
  const [loadError, setLoadError] = useState(error)
  return (
    <AuditSearchPicker
      error={loadError}
      label={label}
      onChange={setValue}
      onRetry={() => setLoadError(undefined)}
      options={options}
      selectedLabel={selectedLabel}
      value={value}
      withAvatars={label === '用户'}
    />
  )
}

// 搜索、键盘与状态展示由 shared/ui/search-list 的测试覆盖，这里只看审计筛选自己的语义。
describe('AuditSearchPicker', () => {
  it('选择选项应用筛选，再次选择当前项清除筛选', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls />)
    const wang = screen.getByRole('option', { name: '小王' })
    expect(wang).toHaveAttribute('aria-selected', 'true')

    await user.click(wang)
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()

    await user.click(screen.getByRole('option', { name: '测试用户' }))
    expect(screen.getByRole('option', { name: '测试用户' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(wang).toHaveAttribute('aria-selected', 'false')
  })

  it('候选读取失败时保留已选项，仍可清除条件', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls error="无法加载用户" />)
    expect(screen.getByRole('alert')).toBeVisible()

    await user.click(screen.getByRole('option', { name: '小王', selected: true }))
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeVisible()
  })

  it.each([
    { label: '用户', selectedLabel: '小陈', optionName: '小陈', options: USERS },
    { label: '需求单', selectedLabel: undefined, optionName: '已选需求单', options: TASKS },
  ])(
    '当前$label已移出候选时保留已选行，取消后移除该行',
    async ({ label, selectedLabel, optionName, options }) => {
      const user = userEvent.setup()
      await renderWithProviders(
        <PickerControls
          initialValue="removed"
          label={label}
          options={options}
          selectedLabel={selectedLabel}
        />,
      )
      const selectedOption = screen.getByRole('option', { name: optionName, selected: true })
      expect(screen.getAllByRole('option')).toHaveLength(options.length + 1)
      expect(screen.getByRole('combobox', { name: `搜索${label}` })).toBeVisible()

      await user.click(selectedOption)
      expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
      expect(screen.queryByRole('option', { name: optionName })).not.toBeInTheDocument()
      expect(screen.getAllByRole('option')).toHaveLength(options.length)
    },
  )
})
