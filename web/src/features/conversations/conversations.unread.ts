/** 浏览器持久化已查看的 lastRunId，供侧栏判断未读；存储不可用时仅影响未读标记。 */

import { useParams } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import type { Conversation, SidebarTopology } from './conversations.api'

const STORAGE_KEY = 'cue.conversations.seen-run'

/** 对话 ID 对应已查看的 lastRunId；null 表示当前运行尚未结束或从未运行。 */
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

// 同步其他标签页的记录，避免后续写入覆盖其更新。
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

/** 记录已查看的运行；仍在运行时传 null，值未变时不写存储。 */
export const recordSeenRun = (conversationId: string, lastRunId: string | null): void => {
  if (conversationId in seen && seen[conversationId] === lastRunId) return
  seen = { ...seen, [conversationId]: lastRunId }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seen))
  } catch {
    // 存储不可用时仅更新当前标签页。
  }
  notify()
}

/** 返回已记录的 lastRunId；undefined 表示本浏览器从未打开该对话。 */
export const useSeenRun = (conversationId: string): string | null | undefined =>
  useSyncExternalStore(subscribe, () => seen[conversationId])

const findRow = (topology: SidebarTopology, conversationId: string): Conversation | undefined =>
  [topology.ungrouped, ...topology.collections.map((one) => one.page)]
    .flatMap((page) => page.items)
    .find((row) => row.id === conversationId)

/** 在拓扑层记录当前对话，避免折叠行未渲染时漏记；运行中记录 null，结束后记录 lastRunId。 */
export const useRecordOpenedConversation = (topology: SidebarTopology | undefined): void => {
  const openedId = useParams({ select: (params) => params.conversationId, strict: false })
  const opened =
    openedId === undefined || topology === undefined ? undefined : findRow(topology, openedId)
  const seenRun = opened === undefined ? undefined : opened.activity.busy ? null : opened.lastRunId
  useEffect(() => {
    if (openedId !== undefined && seenRun !== undefined) recordSeenRun(openedId, seenRun)
  }, [openedId, seenRun])
}
