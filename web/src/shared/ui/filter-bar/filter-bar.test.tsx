import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { FilterBarRoot, FilterPopup, useFilterBar } from './filter-bar'

function Bar() {
  return (
    <FilterBarRoot className="gap-2">
      <Filters />
    </FilterBarRoot>
  )
}

function Filters() {
  const { close } = useFilterBar()
  return (
    <>
      <FilterPopup
        icon="user"
        id="user"
        label="用户"
        popupLabel="选择用户"
        selected={false}
        width="w-60"
      >
        <button onClick={close} type="button">
          选小王
        </button>
      </FilterPopup>
      <FilterPopup
        icon="task"
        id="task"
        label="需求单"
        popupLabel="选择需求单"
        selected={false}
        width="w-72"
      >
        <button onClick={close} type="button">
          选夏季上新
        </button>
      </FilterPopup>
    </>
  )
}

describe('筛选条', () => {
  it('同时只开一个弹层，换一个触发器就换一个弹层', async () => {
    await renderWithProviders(<Bar />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '用户' }))
    expect(await screen.findByRole('dialog', { name: '选择用户' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '需求单' }))
    expect(await screen.findByRole('dialog', { name: '选择需求单' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '选择用户' })).toBeNull()
  })

  it('弹层里选完就关，焦点回到触发器', async () => {
    await renderWithProviders(<Bar />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: '用户' })

    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: '选小王' }))

    expect(screen.queryByRole('dialog', { name: '选择用户' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('Escape 关掉弹层并把焦点还回去', async () => {
    await renderWithProviders(<Bar />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: '需求单' })

    await user.click(trigger)
    await screen.findByRole('dialog', { name: '选择需求单' })
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: '选择需求单' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('内容只在展开时挂载', async () => {
    await renderWithProviders(<Bar />)

    expect(screen.queryByRole('button', { name: '选小王' })).toBeNull()
  })
})
