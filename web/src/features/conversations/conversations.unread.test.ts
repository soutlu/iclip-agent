/** jsdom 存储不可用，使用内存实现验证跨模块重载的未读记录。 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordSeenRun, useSeenRun } from './conversations.unread'

const STORAGE_KEY = 'cue.conversations.seen-run'

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

describe('看过的运行', () => {
  it('没记过是 undefined；记了就读得到，null 也是一个值', () => {
    const { result } = renderHook(() => useSeenRun('c-record'))
    expect(result.current).toBeUndefined()

    act(() => recordSeenRun('c-record', null))
    expect(result.current).toBeNull()

    act(() => recordSeenRun('c-record', 'run-1'))
    expect(result.current).toBe('run-1')
  })

  it('落盘：刷新之后记录还在', async () => {
    recordSeenRun('c-persist', 'run-7')

    vi.resetModules()
    const reloaded = await import('./conversations.unread')

    expect(renderHook(() => reloaded.useSeenRun('c-persist')).result.current).toBe('run-7')
    expect(renderHook(() => reloaded.useSeenRun('c-other')).result.current).toBeUndefined()
  })

  it('另一个标签页写了记录，这里跟着换', async () => {
    vi.resetModules()
    const fresh = await import('./conversations.unread')
    const { result } = renderHook(() => fresh.useSeenRun('c-tab'))
    expect(result.current).toBeUndefined()

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'c-tab': 'run-3' }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    })

    expect(result.current).toBe('run-3')
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

    const { result } = renderHook(() => useSeenRun('c-nostore'))
    expect(() => act(() => recordSeenRun('c-nostore', 'run-1'))).not.toThrow()
    expect(result.current).toBe('run-1')
  })
})
