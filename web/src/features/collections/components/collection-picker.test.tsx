import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { CollectionPicker, type CollectionOption } from './collection-picker'

const OPTIONS = [
  { id: 'social', name: '品牌社媒' },
  { id: 'boots', name: '秋冬靴子' },
  { id: 'kids', name: '儿童运动鞋' },
  { id: 'tiktok', name: 'TikTok 产品展示' },
]

function CollectionControls({
  disabled = false,
  error,
  loading = false,
  options = OPTIONS,
}: {
  disabled?: boolean
  error?: string
  loading?: boolean
  options?: readonly CollectionOption[]
}) {
  const [value, setValue] = useState<string | null>('boots')
  const [loadError, setLoadError] = useState(error)
  return (
    <CollectionPicker
      disabled={disabled}
      error={loadError}
      loading={loading}
      onChange={setValue}
      onCreate={() => {}}
      onRetry={() => setLoadError(undefined)}
      options={options}
      value={value}
    />
  )
}

// jsdom 不执行滚动；真实浏览器验收负责检查活动项滚入视口。
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

describe('CollectionPicker', () => {
  it('选中项置顶，搜索不区分大小写，并可用键盘选择或取消关联', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CollectionControls />)
    await user.click(screen.getByRole('button', { name: '关联合集：秋冬靴子' }))
    expect(screen.getAllByRole('option')[0]).toHaveAccessibleName('秋冬靴子')
    const search = screen.getByRole('combobox', { name: '搜索合集' })
    expect(search).toHaveFocus()
    await user.type(search, 'tiktok')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{ArrowDown}{Enter}')
    const trigger = screen.getByRole('button', { name: '关联合集：TikTok 产品展示' })
    expect(trigger).toBeVisible()
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.keyboard('{Enter}{Tab}{Enter}')
    expect(screen.getByRole('button', { name: '关联合集：未关联合集' })).toBeVisible()
  })

  it('清空搜索恢复列表，Esc 保留当前选择并将焦点归还触发器', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CollectionControls />)
    const trigger = screen.getByRole('button', { name: '关联合集：秋冬靴子' })
    await user.click(trigger)
    await user.type(screen.getByRole('combobox'), '不存在')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status')).toBeVisible()
    expect(screen.getByRole('button', { name: '新建“不存在”' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(screen.getAllByRole('option')).toHaveLength(OPTIONS.length)
    expect(screen.getByRole('combobox')).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('从搜索框向上遍历到末项，并能点击选择已有合集', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CollectionControls />)
    await user.click(screen.getByRole('button', { name: '关联合集：秋冬靴子' }))
    await user.keyboard('{ArrowUp}{Enter}')
    await user.click(screen.getByRole('button', { name: '关联合集：TikTok 产品展示' }))
    await user.click(screen.getByRole('option', { name: '品牌社媒' }))
    expect(screen.getByRole('button', { name: '关联合集：品牌社媒' })).toBeVisible()
  })

  it('加载和空列表均允许不关联或新建，加载期间不显示空列表结果', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CollectionControls loading options={[]} />)
    await user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    expect(screen.getByRole('listbox', { name: '合集' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '不关联合集' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '新建合集' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '不关联合集' }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('显示外部错误并由重试回调清除错误，空列表保留创建入口', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CollectionControls error="读取合集失败" options={[]} />)
    await user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status')).toBeVisible()
    expect(screen.getByRole('button', { name: '新建合集' })).toBeEnabled()
  })

  it('发送期间禁用选择入口', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CollectionControls disabled />)
    const trigger = screen.getByRole('button', { name: '关联合集：秋冬靴子' })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('未提供创建权限时隐藏新建入口，仍可选择已有合集', async () => {
    const user = userEvent.setup()
    await renderWithProviders(
      <CollectionPicker onChange={() => {}} options={OPTIONS} value={null} />,
    )
    await user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    expect(screen.getAllByRole('option')).toHaveLength(OPTIONS.length)
    expect(screen.queryByRole('button', { name: /新建/ })).not.toBeInTheDocument()
    await user.type(screen.getByRole('combobox'), '不存在')
    expect(screen.queryByRole('button', { name: /新建/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '不关联合集' })).toBeEnabled()
  })
})
