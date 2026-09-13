import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SearchListInput,
  SearchListOptions,
  SearchListRoot,
  SearchListStatus,
  useSearchList,
} from './search-list'

const FRUITS = [
  { id: 'apple', label: '苹果' },
  { id: 'pear', label: '梨' },
  { id: 'tiktok', label: 'TikTok 产品展示' },
]

function Harness({
  options = FRUITS,
  initialValue = null,
  disabled = false,
  pending = false,
  error,
}: {
  options?: readonly { id: string; label: string }[]
  initialValue?: string | null
  disabled?: boolean
  pending?: boolean
  error?: string
}) {
  const [value, setValue] = useState(initialValue)
  const [loadError, setLoadError] = useState(error)
  return (
    <SearchListRoot
      disabled={disabled}
      error={loadError}
      onSelect={setValue}
      options={options}
      pending={pending}
      value={value}
    >
      <SearchListInput label="搜索水果" />
      <SearchListOptions label="水果" />
      <SearchListStatus label="水果" onRetry={() => setLoadError(undefined)} />
      <QueryEcho />
    </SearchListRoot>
  )
}

function QueryEcho() {
  const { query, setQuery } = useSearchList()
  return (
    <button onClick={() => setQuery('')} type="button">
      清空搜索词 {query}
    </button>
  )
}

// jsdom 不执行滚动；浏览器验收负责活动项滚入可视区域。
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

describe('SearchList', () => {
  it('键盘循环遍历、跳到首尾并用 Enter 选择，活动项由搜索框的 ARIA 关联表达', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const search = screen.getByRole('combobox', { name: '搜索水果' })
    const list = screen.getByRole('listbox', { name: '水果' })
    const first = screen.getByRole('option', { name: '苹果' })
    const last = screen.getByRole('option', { name: 'TikTok 产品展示' })
    expect(search).toHaveAttribute('aria-controls', list.id)
    await user.click(search)

    await user.keyboard('{ArrowUp}')
    expect(search).toHaveAttribute('aria-activedescendant', last.id)
    await user.keyboard('{ArrowDown}')
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
    await user.keyboard('{End}')
    expect(search).toHaveAttribute('aria-activedescendant', last.id)
    await user.keyboard('{Home}')
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
    await user.keyboard('{Enter}')
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(search).toHaveFocus()
  })

  it('点击或悬停选项后焦点留在搜索框，选中态跟随 value', async () => {
    const user = userEvent.setup()
    render(<Harness initialValue="pear" />)
    const search = screen.getByRole('combobox', { name: '搜索水果' })
    const pear = screen.getByRole('option', { name: '梨' })
    const apple = screen.getByRole('option', { name: '苹果' })
    expect(pear).toHaveAttribute('aria-selected', 'true')

    await user.click(search)
    await user.hover(apple)
    expect(search).toHaveFocus()
    await user.click(apple)
    expect(apple).toHaveAttribute('aria-selected', 'true')
    expect(pear).toHaveAttribute('aria-selected', 'false')
    expect(search).toHaveFocus()
  })

  it('搜索忽略首尾空白和大小写，候选变化清掉旧活动项，没有匹配时显示空态', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const search = screen.getByRole('combobox', { name: '搜索水果' })
    await user.type(search, ' tIkToK ')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{ArrowDown}')
    expect(search).toHaveAttribute('aria-activedescendant')

    await user.type(search, '不存在')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(search).not.toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('status')).toHaveTextContent('未找到匹配的水果')

    await user.click(screen.getByRole('button', { name: /清空搜索词/ }))
    expect(screen.getAllByRole('option')).toHaveLength(FRUITS.length)
  })

  it('输入法确认与系统编辑快捷键不触发选择或移动', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const search = screen.getByRole('combobox', { name: '搜索水果' })
    const first = screen.getByRole('option', { name: '苹果' })
    await user.click(search)
    await user.keyboard('{ArrowDown}')

    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(search, { key: 'End', ctrlKey: true })
    fireEvent.keyDown(search, { key: 'Enter', metaKey: true })
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
  })

  it('加载中标记列表忙碌并显示加载文案，键盘不产生活动项', async () => {
    const user = userEvent.setup()
    render(<Harness options={[]} pending />)
    const search = screen.getByRole('combobox', { name: '搜索水果' })
    expect(screen.getByRole('listbox', { name: '水果' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('正在加载水果')
    expect(screen.queryAllByRole('option')).toHaveLength(0)

    await user.click(search)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(search).not.toHaveAttribute('aria-activedescendant')
  })

  it('读取失败时错误与缓存候选并存，重试后焦点回到搜索框', async () => {
    const user = userEvent.setup()
    render(<Harness error="无法加载水果" />)
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载水果')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(FRUITS.length)

    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '搜索水果' })).toHaveFocus()
  })

  it('候选为空时显示空态，搜索框仍可用', () => {
    render(<Harness options={[]} />)
    expect(screen.getByRole('status')).toHaveTextContent('暂无可选水果')
    expect(screen.getByRole('listbox', { name: '水果' })).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('combobox', { name: '搜索水果' })).toBeEnabled()
  })

  it('禁用时搜索框与选项都不可操作', async () => {
    const user = userEvent.setup()
    render(<Harness disabled />)
    expect(screen.getByRole('combobox', { name: '搜索水果' })).toBeDisabled()
    for (const option of screen.getAllByRole('option')) expect(option).toBeDisabled()

    await user.click(screen.getByRole('option', { name: '苹果' }))
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
  })
})
