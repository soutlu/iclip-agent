/**
 * 「我最后一次看着这段对话闲下来时，它跑到了哪一次运行」记在浏览器里。
 *
 * 侧栏拿这份记录和列表行上的 `lastRunId` 比：不一样、且那一轮已经跑完，就是有一次运行是我没
 * 看着结束的。记录是本地事实，后端不存：它只跟这台机器上的这个人看没看过有关。
 *
 * 落盘是为了跨刷新还在；读写都可能抛（无痕模式、站点存储被策略禁掉），抛了就当没存过——
 * 顶多是点不见了，不该把侧栏拖垮。
 */

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'cue.conversations.seen-run'

/** 对话 id → 看着它闲下来时的 `lastRunId`；`null` 是「看着它，但当前这一次还没结束」或从没跑过。 */
type SeenRuns = Readonly<Record<string, string | null>>

const read = (): SeenRuns => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = stored === null ? null : JSON.parse(stored)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, one]) => one === null || typeof one === 'string'),
    )
  } catch {
    return {}
  }
}

let seen: SeenRuns = read()
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of listeners) listener()
}

// 另一个标签页写了这份记录，这里跟着换：不然两边各存一份，谁后写谁把对方的覆盖掉。
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return
  seen = read()
  notify()
})

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * 记下「我正看着这段对话，它此刻跑到了哪一次」。侧栏里打开着的那一行每次渲染都调，值没变不写。
 *
 * @param conversationId - 哪一段对话。
 * @param lastRunId - 闲着时是行上的 `lastRunId`；还在跑就传 `null`——当前这一次还没看着它结束。
 */
export const recordSeenRun = (conversationId: string, lastRunId: string | null): void => {
  if (conversationId in seen && seen[conversationId] === lastRunId) return
  seen = { ...seen, [conversationId]: lastRunId }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seen))
  } catch {
    // 存不下就只在这一次会话里生效
  }
  notify()
}

/**
 * 这段对话我最后一次看着它时跑到了哪一次。
 *
 * @param conversationId - 哪一段对话。
 * @returns 记过的 `lastRunId`；`undefined` 是在这台浏览器上从没打开过它。
 */
export const useSeenRun = (conversationId: string): string | null | undefined =>
  useSyncExternalStore(subscribe, () => seen[conversationId])
