import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { ListEmpty, ListError, ListPending, LoadMoreFooter } from './list-state'

describe('列表状态块', () => {
  it('读取中是 status，失败是 alert 且重试按钮回调', async () => {
    const onRetry = vi.fn()
    await renderWithProviders(
      <>
        <ListPending label="正在读取对话" />
        <ListError message="读取失败了" onRetry={onRetry} />
        <ListEmpty>什么都没有</ListEmpty>
      </>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('正在读取对话')
    expect(screen.getByRole('alert')).toHaveTextContent('读取失败了')
    expect(screen.getByText('什么都没有')).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: '重新加载' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it.each([
    { shown: undefined, total: undefined, counter: null },
    { shown: 50, total: undefined, counter: '已显示 50' },
    { shown: 50, total: 120, counter: '已显示 50 / 120' },
  ])('页脚按给没给计数写「已显示」：$counter', async ({ shown, total, counter }) => {
    const onMore = vi.fn()
    await renderWithProviders(
      <LoadMoreFooter
        isFetching={false}
        label="显示更多"
        onMore={onMore}
        shown={shown}
        total={total}
      />,
    )

    if (counter === null) {
      expect(screen.queryByText(/已显示/)).toBeNull()
    } else {
      expect(screen.getByText(counter)).toBeVisible()
    }
    await userEvent.setup().click(screen.getByRole('button', { name: '显示更多' }))
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('读取下一页时按钮禁用并换文字', async () => {
    await renderWithProviders(<LoadMoreFooter isFetching label="显示更多" onMore={() => {}} />)

    expect(screen.getByRole('button', { name: '正在读取…' })).toBeDisabled()
  })
})
