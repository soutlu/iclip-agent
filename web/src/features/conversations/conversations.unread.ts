/**
 * 「跑完了还没看」记在浏览器里。
 *
 * 后端不存这件事：它只跟这台机器上的这个人看没看过有关。落盘是为了跨刷新还在；读写都可能抛
 * （无痕模式、站点存储被策略禁掉），抛了就当没存过——顶多是点不见了，不该把侧栏拖垮。
 */

import { useEffect, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'cue.conversations.unread'

const read = (): ReadonlySet<string> => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = stored === null ? null : JSON.parse(stored)
    return new Set(Array.isArray(parsed) ? parsed.filter((one) => typeof one === 'string') : [])
  } catch {
    return new Set()
  }
}

let unread: ReadonlySet<string> = read()
const listeners = new Set<() => void>()

const commit = (next: ReadonlySet<string>): void => {
  unread = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // 存不下就只在这一次会话里生效
  }
  for (const listener of listeners) listener()
}

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** 这一轮跑完时人不在这段对话上：记一笔，等他回来。 */
export const markUnread = (conversationId: string): void => {
  if (unread.has(conversationId)) return
  commit(new Set(unread).add(conversationId))
}

/** 看过了。 */
export const clearUnread = (conversationId: string): void => {
  if (!unread.has(conversationId)) return
  const next = new Set(unread)
  next.delete(conversationId)
  commit(next)
}

/**
 * 这一行要不要画那个点。
 *
 * @param conversationId - 哪一段对话。
 * @returns 跑完了还没看就是 `true`。
 */
export const useUnread = (conversationId: string): boolean =>
  useSyncExternalStore(subscribe, () => unread.has(conversationId))

/**
 * 打开着这段对话就把点清掉。会话页调一次。
 *
 * @param conversationId - 打开的是哪一段。
 */
export const useClearUnread = (conversationId: string): void => {
  useEffect(() => {
    clearUnread(conversationId)
  }, [conversationId])
}
