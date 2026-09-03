/**
 * 这套 jsdom 没有可用的 localStorage（`clear` 都不是个函数），正好是这个 hook 要兜住的那种环境。
 * 所以用例自己装一份最小的内存实现，另有一条用例把它换成「一读就抛」，验默认宽这条退路。
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStoredWidth } from './-use-stored-width'

const KEY = 'cue.layout.sidebar-width'

const installStorage = (storage: Partial<Storage>) => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
}

const memoryStorage = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  }
}

afterEach(() => {
  installStorage(memoryStorage())
})

describe('useStoredWidth', () => {
  it('没存过就用默认宽', () => {
    installStorage(memoryStorage())
    const { result } = renderHook(() => useStoredWidth('sidebar-width', 264))
    expect(result.current.width).toBe(264)
  })

  it('落盘之后再挂载读回存过的那个', () => {
    installStorage(memoryStorage())
    const first = renderHook(() => useStoredWidth('sidebar-width', 264))
    act(() => {
      first.result.current.setWidth(320)
      first.result.current.persist(320)
    })

    const second = renderHook(() => useStoredWidth('sidebar-width', 264))
    expect(second.result.current.width).toBe(320)
  })

  it('改宽但没落盘就不留下', () => {
    installStorage(memoryStorage())
    const first = renderHook(() => useStoredWidth('sidebar-width', 264))
    act(() => first.result.current.setWidth(320))

    const second = renderHook(() => useStoredWidth('sidebar-width', 264))
    expect(second.result.current.width).toBe(264)
  })

  it.each([
    ['存的不是数', 'wide'],
    ['存的是空串', ''],
  ])('%s 时退回默认宽', (_case, stored) => {
    const storage = memoryStorage()
    storage.setItem(KEY, stored)
    installStorage(storage)

    const { result } = renderHook(() => useStoredWidth('sidebar-width', 264))
    expect(result.current.width).toBe(264)
  })

  it('站点存储被禁掉时照常给默认宽，写入也不抛', () => {
    installStorage({
      getItem: () => {
        throw new Error('存储被策略禁掉了')
      },
      setItem: () => {
        throw new Error('存储被策略禁掉了')
      },
    })

    const { result } = renderHook(() => useStoredWidth('sidebar-width', 264))
    expect(result.current.width).toBe(264)
    expect(() => result.current.persist(320)).not.toThrow()
  })
})
