/**
 * 记在浏览器里的一个布局宽度。
 *
 * 拖过之后刷新还在，是这套拖柄唯一的持久化需求，所以不进后端、也不进 URL。读写都可能抛
 * （无痕模式、被策略禁掉的站点存储），抛了就当没存过——布局退回默认值，不该把整页拖垮。
 */

import { useCallback, useState } from 'react'

const PREFIX = 'cue.layout.'

const read = (key: string, fallback: number): number => {
  try {
    const stored = window.localStorage.getItem(PREFIX + key)
    // 空串 Number() 出来是 0，不挡住的话侧栏会以 0 宽起步。
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
    // 存不下就只在这一次会话里生效，不打断拖动。
  }
}

/**
 * 一个可拖动的宽度：初值取存过的那个，`persist` 在拖完那一刻落盘。
 *
 * 拖动中不落盘：指针每动一像素写一次 localStorage 是同步磁盘 IO，会把拖动卡出顿挫。
 *
 * @param key - 存储键（会自动加前缀）。
 * @param fallback - 没存过时用的默认宽。
 * @returns 当前宽度、就地改宽、落盘。
 */
export const useStoredWidth = (key: string, fallback: number) => {
  const [width, setWidth] = useState(() => read(key, fallback))
  const persist = useCallback((value: number) => write(key, value), [key])
  return { persist, setWidth, width }
}
