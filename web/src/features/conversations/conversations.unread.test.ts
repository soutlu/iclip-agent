/**
 * 「跑完了还没看」这份本地记录。
 *
 * 这套 jsdom 没有可用的 localStorage，所以用例自己装一份内存实现（同 `-use-stored-width.test.ts`）。
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearUnread, markUnread, useUnread } from './conversations.unread'

const memoryStorage = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() })
})

describe('未读', () => {
  it('记一笔，看过了清掉，列着的行跟着换', () => {
    const { result } = renderHook(() => useUnread('c-mark'))
    expect(result.current).toBe(false)

    act(() => markUnread('c-mark'))
    expect(result.current).toBe(true)

    act(() => clearUnread('c-mark'))
    expect(result.current).toBe(false)
  })

  it('落盘：刷新之后那个点还在', async () => {
    markUnread('c-persist')

    // 换一份新的模块实例，等于刷新页面之后重新读一遍
    vi.resetModules()
    const reloaded = await import('./conversations.unread')

    expect(renderHook(() => reloaded.useUnread('c-persist')).result.current).toBe(true)
    expect(renderHook(() => reloaded.useUnread('c-mark')).result.current).toBe(false)
  })

  it('站点存储被禁掉时照常记得住，写入也不抛', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('存储被策略禁掉了')
        },
        setItem: () => {
          throw new Error('存储被策略禁掉了')
        },
      },
    })

    const { result } = renderHook(() => useUnread('c-nostore'))
    expect(() => act(() => markUnread('c-nostore'))).not.toThrow()
    expect(result.current).toBe(true)
  })
})
