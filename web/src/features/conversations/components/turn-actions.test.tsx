/**
 * 轮尾终态栏：复制反馈、token 统计的显隐与格式化、完成时刻的格式化与悬停信息、
 * 重新生成按钮的接线。时刻段的 hover 浮现是视觉行为，由截图验收，这里只断言文本与 title。
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

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 与组件约定一致的时刻段 title：YYYY/MM/DD HH:mm:ss。 */
const fullTitle = (date: Date): string =>
  `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`

/** 时刻段 title 的形状，用来在缺 endedAt / 无法解析时断言它没渲染。 */
const TIME_TITLE_RE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/

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

  it('统计段的悬停 title 给千分位精确值', () => {
    render(
      <TurnActions
        copyText="回复"
        usage={{ inputTokens: 12340, cachedTokens: 4910, outputTokens: 1214 }}
      />,
    )

    expect(screen.getByText('输入 12.34k · 缓存 4.91k · 输出 1.21k')).toHaveAttribute(
      'title',
      '输入 12,340 · 缓存 4,910 · 输出 1,214',
    )
  })

  it('endedAt 缺失时时刻段不渲染', () => {
    render(<TurnActions copyText="回复" usage={{ inputTokens: 12340 }} />)

    expect(screen.queryByTitle(TIME_TITLE_RE)).toBeNull()
  })

  it('endedAt 解析不出时时刻段不渲染，统计段照常', () => {
    render(<TurnActions copyText="回复" endedAt="垃圾" usage={{ inputTokens: 12340 }} />)

    expect(screen.queryByTitle(TIME_TITLE_RE)).toBeNull()
    expect(screen.getByText('输入 12.34k · 缓存 0 · 输出 0')).toBeInTheDocument()
  })

  it('今天完成的时刻只显 HH:mm，title 留精确完整时刻', () => {
    const ended = new Date()
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    const time = screen.getByTitle(fullTitle(ended))
    expect(time).toHaveTextContent(/^\d{2}:\d{2}$/)
  })

  it('昨天完成的时刻补「昨天」前缀', () => {
    const now = new Date()
    const ended = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 30, 5)
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(screen.getByTitle(fullTitle(ended))).toHaveTextContent('昨天 14:30')
  })

  it('更早且同年完成的时刻显 M月d日 HH:mm', () => {
    const now = new Date()
    // 两天前落在去年（1 月 1 / 2 日跑测试）时，改用当年 12 月 31 日——同样保证不是今天 / 昨天
    let ended = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 8, 9, 7)
    if (ended.getFullYear() !== now.getFullYear()) {
      ended = new Date(now.getFullYear(), 11, 31, 8, 9, 7)
    }
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(screen.getByTitle(fullTitle(ended))).toHaveTextContent(
      /^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/,
    )
  })

  it('跨自然年完成的时刻补年份', () => {
    const ended = new Date(2020, 0, 2, 3, 4, 5)
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    const time = screen.getByTitle('2020/01/02 03:04:05')
    expect(time).toHaveTextContent('2020年1月2日 03:04')
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
