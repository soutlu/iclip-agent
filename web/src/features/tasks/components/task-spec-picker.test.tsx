import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { renderWithProviders } from '@/testing/render'
import { TaskSpecPicker } from './task-spec-picker'

const PLATFORMS = [
  { value: 'douyin', label: '抖音' },
  { value: 'amazon', label: 'Amazon' },
]
const RATIOS = [
  { value: '', label: '未指定' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
]

function PickerForm({
  allowCustom = true,
  initialValue = '',
  disabled = false,
}: {
  allowCustom?: boolean
  initialValue?: string
  disabled?: boolean
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <TaskSpecPicker
        allowCustom={allowCustom}
        disabled={disabled}
        label={allowCustom ? '发布平台' : '比例'}
        onChange={setValue}
        options={allowCustom ? PLATFORMS : RATIOS}
        value={value}
      />
      <input aria-label="下一个字段" />
    </>
  )
}

// jsdom 不执行滚动；实际弹层定位和滚动由浏览器验收。
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

describe('TaskSpecPicker', () => {
  it('回显已有值，输入已知显示名时选中合同值，并允许清空', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerForm initialValue="amazon" />)
    const input = screen.getByRole('combobox', { name: '发布平台' })
    expect(input).toHaveValue('Amazon')

    await user.clear(input)
    await user.type(input, '抖音')
    expect(screen.getByRole('option', { name: '抖音', selected: true })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '清空发布平台' }))
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
  })

  it('未知值保持原文，继续编辑后通过 Tab 保留并移动到下一个字段', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerForm initialValue="小红书" />)
    const input = screen.getByLabelText('发布平台')
    expect(input).toHaveValue('小红书')

    await user.clear(input)
    await user.type(input, '自定义平台')
    expect(screen.getByRole('status')).toBeVisible()
    await user.tab()
    expect(input).toHaveValue('自定义平台')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByLabelText('下一个字段')).toHaveFocus()
  })

  it('方向键打开并循环定位建议值，Enter 选择后收起', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerForm />)
    await user.tab()
    const input = screen.getByRole('combobox', { name: '发布平台' })
    expect(input).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    const first = screen.getByRole('option', { name: '抖音' })
    expect(input).toHaveAttribute('aria-activedescendant', first.id)
    await user.keyboard('{ArrowUp}{Enter}')
    expect(input).toHaveValue('Amazon')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveFocus()

    await user.click(screen.getByRole('button', { name: '展开发布平台选项' }))
    expect(screen.getByRole('option', { name: 'Amazon', selected: true })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '收起发布平台选项' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('比例只能选择候选并能恢复未指定', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerForm allowCustom={false} initialValue="9:16" />)
    const picker = screen.getByRole('combobox', { name: '比例' })
    expect(picker).toHaveTextContent('9:16')

    await user.click(picker)
    expect(screen.getByRole('option', { name: '9:16', selected: true })).toBeVisible()
    await user.click(picker)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.click(picker)
    await user.click(screen.getByRole('option', { name: '未指定' }))
    expect(picker).toHaveTextContent('未指定')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(picker).toHaveTextContent('1:1')
  })

  it.each([true, false])('disabled 时不可展开或编辑（allowCustom=%s）', async (allowCustom) => {
    const user = userEvent.setup()
    await renderWithProviders(<PickerForm allowCustom={allowCustom} disabled />)
    const picker = screen.getByRole('combobox')
    expect(picker).toBeDisabled()
    await user.click(picker)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.tab()
    expect(screen.getByLabelText('下一个字段')).toHaveFocus()
  })

  it('Escape 只关闭规格选项，保留外层需求单弹窗', async () => {
    const user = userEvent.setup()
    await renderWithProviders(
      <DialogRoot defaultOpen>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭需求单" title="需求单" />
          <PickerForm />
        </DialogSurface>
      </DialogRoot>,
    )
    await user.click(screen.getByRole('combobox', { name: '发布平台' }))
    expect(screen.getByRole('listbox')).toBeVisible()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: '需求单' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: '发布平台' })).toHaveFocus()
  })
})
