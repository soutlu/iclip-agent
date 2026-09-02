/**
 * 轮尾操作行：复制反馈、token 统计的显隐与格式化、悬停 title、重新生成按钮的接线。
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
import { TurnActions } from './turn-actions'

/** jsdom 没有剪贴板，垫一个能断言的最小实现。 */
const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

describe('TurnActions', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('点复制把回复写进剪贴板，反馈「已复制」1.4s 后复位', async () => {
    vi.useFakeTimers()
    const writeText = stubClipboard()
    render(<TurnActions copyText="最终回复" />)

    const button = screen.getByRole('button', { name: '复制' })
    fireEvent.click(button)
    // writeText 之后 setCopied 走微任务，刷一轮让它落定
    await act(async () => {})

    expect(writeText).toHaveBeenCalledWith('最终回复')
    expect(button).toHaveAttribute('title', '已复制')

    act(() => {
      vi.advanceTimersByTime(1400)
    })
    expect(button).toHaveAttribute('title', '复制')
  })

  it('这轮没有 usage 时统计段整段不渲染', () => {
    render(<TurnActions copyText="回复" endedAt={new Date().toISOString()} />)

    expect(screen.queryByText(/输出/)).toBeNull()
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
  })

  it.each<[TranscriptUsage, string]>([
    [
      { inputTokens: 12340, cachedTokens: 4910, outputTokens: 1214 },
      '输入 12.34k · 缓存 4.91k · 输出 1.21k',
    ],
    [{ inputTokens: 999, cachedTokens: 45, outputTokens: 8 }, '输入 999 · 缓存 45 · 输出 8'],
    [
      { inputTokens: 1000, cachedTokens: 2500, outputTokens: 30000 },
      '输入 1k · 缓存 2.5k · 输出 30k',
    ],
    [{ inputTokens: 2048, outputTokens: 64 }, '输入 2.05k · 缓存 0 · 输出 64'],
  ])('三段统计按 k 缩略渲染：%j → %s', (usage, line) => {
    render(<TurnActions copyText="回复" usage={usage} />)

    expect(screen.getByText(line)).toBeInTheDocument()
  })

  it('悬停 title 给千分位精确值，跨天完成的带日期', () => {
    render(
      <TurnActions
        copyText="回复"
        endedAt={new Date(2020, 0, 2, 3, 4, 5).toISOString()}
        usage={{ inputTokens: 12340, cachedTokens: 4910, outputTokens: 1214 }}
      />,
    )

    expect(screen.getByText('输入 12.34k · 缓存 4.91k · 输出 1.21k')).toHaveAttribute(
      'title',
      '输入 12,340 · 缓存 4,910 · 输出 1,214\n完成于 2020/01/02 03:04:05',
    )
  })

  it('当天完成的 title 只显时分秒', () => {
    render(
      <TurnActions
        copyText="回复"
        endedAt={new Date().toISOString()}
        usage={{ inputTokens: 12340, cachedTokens: 4910, outputTokens: 1214 }}
      />,
    )

    expect(screen.getByText(/输入 12\.34k/).getAttribute('title')).toMatch(
      /^输入 12,340 · 缓存 4,910 · 输出 1,214\n完成于 \d{2}:\d{2}:\d{2}$/,
    )
  })

  it('endedAt 缺失时 title 只有精确值那行', () => {
    render(<TurnActions copyText="回复" usage={{ inputTokens: 12340 }} />)

    expect(screen.getByText('输入 12.34k · 缓存 0 · 输出 0')).toHaveAttribute(
      'title',
      '输入 12,340 · 缓存 0 · 输出 0',
    )
  })

  it('没传 onRegenerate 时不渲染重新生成钮', () => {
    render(<TurnActions copyText="回复" />)

    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull()
  })

  it('传了 onRegenerate 时点它触发回调', async () => {
    const onRegenerate = vi.fn()
    const user = userEvent.setup()
    render(<TurnActions copyText="回复" onRegenerate={onRegenerate} />)

    await user.click(screen.getByRole('button', { name: '重新生成' }))

    expect(onRegenerate).toHaveBeenCalledOnce()
  })

  it('regenerateDisabled 时重新生成钮置灰不可点', () => {
    render(<TurnActions copyText="回复" onRegenerate={vi.fn()} regenerateDisabled />)

    expect(screen.getByRole('button', { name: '重新生成' })).toBeDisabled()
  })
})
