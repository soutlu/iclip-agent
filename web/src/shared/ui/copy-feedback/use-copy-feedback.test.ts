import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCopyFeedback } from './use-copy-feedback'

const stubClipboard = (writeText = vi.fn().mockResolvedValue(undefined)) => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useCopyFeedback', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('复制成功后回显「已复制」1.4s 再复位', async () => {
    vi.useFakeTimers()
    const writeText = stubClipboard()
    const { result } = renderHook(() => useCopyFeedback())

    await act(() => result.current.copy('正文'))
    expect(writeText).toHaveBeenCalledWith('正文')
    expect(result.current.copied).toBe(true)

    advance(1399)
    expect(result.current.copied).toBe(true)
    advance(1)
    expect(result.current.copied).toBe(false)
  })

  it('回显期间再复制从头计时', async () => {
    vi.useFakeTimers()
    stubClipboard()
    const { result } = renderHook(() => useCopyFeedback())

    await act(() => result.current.copy('第一次'))
    advance(1000)
    await act(() => result.current.copy('第二次'))
    advance(1000)
    expect(result.current.copied).toBe(true)
    advance(400)
    expect(result.current.copied).toBe(false)
  })

  it('卸载时清掉回显计时', async () => {
    vi.useFakeTimers()
    stubClipboard()
    const { result, unmount } = renderHook(() => useCopyFeedback())

    await act(() => result.current.copy('正文'))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('剪贴板拒绝时不进入已复制状态', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    const { result } = renderHook(() => useCopyFeedback())

    await act(() => result.current.copy('正文'))
    expect(result.current.copied).toBe(false)
  })
})
