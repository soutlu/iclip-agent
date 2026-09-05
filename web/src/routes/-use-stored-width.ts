/** 布局宽度仅存于浏览器；存储不可用时使用默认值，不影响页面加载。 */

import { useCallback, useState } from 'react'

const PREFIX = 'cue.layout.'

const read = (key: string, fallback: number): number => {
  try {
    const stored = window.localStorage.getItem(PREFIX + key)
    // Number('') 为 0，空值必须先排除。
    const parsed = stored === null || stored.trim() === '' ? Number.NaN : Number(stored)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  } catch {
    return fallback
  }
}

const write = (key: string, value: number): void => {
  try {
    window.localStorage.setItem(PREFIX + key, String(value))
  } catch {
    // 存储不可用时保留当前会话中的宽度。
  }
}

/** 仅在拖动结束时 persist，避免 localStorage 同步写入阻塞拖动。 */
export const useStoredWidth = (key: string, fallback: number) => {
  const [width, setWidth] = useState(() => read(key, fallback))
  const persist = useCallback((value: number) => write(key, value), [key])
  return { persist, setWidth, width }
}
