import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  isPending = false,
  label = '用户',
  options = USERS,
  initialValue = 'wang',
  selectedLabel,
}: {
  error?: string
  isPending?: boolean
  label?: '用户' | '需求单'
  options?: readonly { id: string; label: string }[]
  initialValue?: string | null
  selectedLabel?: string | undefined
}) {
  const [value, setValue] = useState(initialValue)
  const [loadError, setLoadError] = useState(error)
  return (
    <AuditSearchPicker
      error={loadError}
      isPending={isPending}
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

// jsdom 不执行滚动；浏览器验收覆盖活动项滚入可视区域。
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  })
})
afterAll(() => {
  if (originalScrollIntoView)
    Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

describe('AuditSearchPicker', () => {
  it('点击选项应用筛选，再次点击当前项清除筛选，焦点留在搜索框', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls />)
    const search = screen.getByRole('combobox', { name: '搜索用户' })
    const wang = screen.getByRole('option', { name: '小王' })
    expect(wang).toHaveAttribute('aria-selected', 'true')

    await user.click(search)
    await user.click(wang)
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
    expect(search).toHaveFocus()

    const tester = screen.getByRole('option', { name: '测试用户' })
    await user.hover(tester)
    expect(search).toHaveFocus()
    await user.click(tester)
    expect(tester).toHaveAttribute('aria-selected', 'true')
    expect(wang).toHaveAttribute('aria-selected', 'false')
    expect(search).toHaveFocus()
  })

  it('键盘可循环遍历、跳到首尾并选择，活动项由搜索框的 ARIA 关联表达', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls initialValue={null} />)
    const search = screen.getByRole('combobox', { name: '搜索用户' })
    const list = screen.getByRole('listbox', { name: '用户' })
    const first = screen.getByRole('option', { name: '测试用户' })
    const last = screen.getByRole('option', { name: '治理者' })
    expect(search).toHaveAttribute('aria-controls', list.id)
    await user.click(search)

    await user.keyboard('{ArrowUp}')
    expect(search).toHaveAttribute('aria-activedescendant', last.id)
    await user.keyboard('{Home}')
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
    await user.keyboard('{End}')
    expect(search).toHaveAttribute('aria-activedescendant', last.id)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
    expect(search).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
  })

  it('搜索忽略首尾空白和大小写，候选变化会清除旧活动项', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls initialValue={null} label="需求单" options={TASKS} />)
    const search = screen.getByRole('combobox', { name: '搜索需求单' })
    await user.type(search, ' tIkToK ')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    const match = screen.getByRole('option', { name: 'TikTok 产品展示' })
    await user.keyboard('{ArrowDown}{Enter}')
    expect(match).toHaveAttribute('aria-selected', 'true')

    await user.type(search, '不存在')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(search).not.toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('status')).toBeVisible()

    await user.clear(search)
    expect(screen.getAllByRole('option')).toHaveLength(TASKS.length)
    expect(screen.getByRole('option', { name: 'TikTok 产品展示' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('输入法确认与系统编辑快捷键不触发选项选择或移动', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls initialValue={null} />)
    const search = screen.getByRole('combobox', { name: '搜索用户' })
    const first = screen.getByRole('option', { name: '测试用户' })
    await user.click(search)
    await user.keyboard('{ArrowDown}')

    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(search, { key: 'End', ctrlKey: true })
    fireEvent.keyDown(search, { key: 'Enter', metaKey: true })
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
    expect(search).toHaveAttribute('aria-activedescendant', first.id)

    await user.keyboard('{Enter}')
    expect(first).toHaveAttribute('aria-selected', 'true')
  })

  it('初次加载期间标记列表忙碌，不呈现空状态', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls initialValue={null} isPending options={[]} />)
    const search = screen.getByRole('combobox', { name: '搜索用户' })
    expect(screen.getByRole('listbox', { name: '用户' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status')).toBeVisible()

    await user.click(search)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(search).not.toHaveAttribute('aria-activedescendant')
  })

  it('后台刷新失败时保留缓存候选和当前选择，仍可清除条件并重试', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerControls error="无法加载用户" />)
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(USERS.length)

    await user.click(screen.getByRole('combobox', { name: '搜索用户' }))
    await user.click(screen.getByRole('option', { name: '小王', selected: true }))
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(USERS.length)
    expect(screen.getByRole('combobox', { name: '搜索用户' })).toHaveFocus()
    expect(screen.getByRole('option', { name: '小王' })).toHaveAttribute('aria-selected', 'false')
  })

  it.each([
    { label: '用户' as const, selectedLabel: '小陈', optionName: '小陈', options: USERS },
    {
      label: '需求单' as const,
      selectedLabel: undefined,
      optionName: '已选需求单',
      options: TASKS,
    },
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

      await user.click(screen.getByRole('combobox', { name: `搜索${label}` }))
      await user.click(selectedOption)
      expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
      expect(screen.queryByRole('option', { name: optionName })).not.toBeInTheDocument()
      expect(screen.getAllByRole('option')).toHaveLength(options.length)
    },
  )

  it('候选为空时呈现空状态，并保持搜索框可用', async () => {
    await renderWithProviders(<PickerControls initialValue={null} options={[]} />)
    expect(screen.getByRole('status')).toBeVisible()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('combobox', { name: '搜索用户' })).toBeEnabled()
    expect(screen.getByRole('listbox', { name: '用户' })).toHaveAttribute('aria-busy', 'false')
  })
})
