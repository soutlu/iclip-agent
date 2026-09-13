/** 会话查询缓存是列表事实源；全局帧同时更新拓扑、额外分页、搜索结果与全部对话页里的匹配行。 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { useUser } from '@/shared/auth'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { conversationsQueryKeys, type Conversation } from './conversations.api'

type RowPatch = { title: string } | { activity: Conversation['activity'] }

/** 在侧栏顶层订阅一次全局会话更新；治理者还会收到别人对话的帧。 */
export const useLiveConversations = (enabled = true): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()
  const userId = useUser().data?.id ?? null

  useEffect(() => {
    if (!enabled) return
    return connection.watchSessions((update) => {
      if (update.kind === 'reconnected') {
        // 全局帧不支持补发；重连后丢弃额外分页并刷新拓扑与全部对话页，恢复一致状态。
        queryClient.removeQueries({ queryKey: conversationsQueryKeys.moreAll })
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.auditAll })
        return
      }
      // 生成任务帧归分镜页消费，列表行上没有它的字段。
      if (update.kind === 'generation') return

      const patch: RowPatch =
        update.kind === 'title'
          ? { title: update.title }
          : {
              activity: {
                busy: update.busy,
                lastTurnReason: update.lastTurnReason,
                pendingInteraction: update.pendingInteraction,
              },
            }
      queryClient.setQueriesData({ queryKey: conversationsQueryKeys.all }, (data: unknown) =>
        patchConversation(data, update.conversationId, patch),
      )

      if (update.kind !== 'activity') return

      // 全部对话页的筛选归属与两个总数都由服务端重算；不在缓存里的新对话也靠这次重拉出现。
      void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.auditAll })

      // 别人的对话不在自己的侧栏里，不为它重拉拓扑；认不出属主的按自己的处理。
      const owner = ownerOf(queryClient, update.conversationId)
      if (owner !== undefined && owner !== userId) return

      if (!update.busy && update.lastTurnReason === 'completed') {
        // 运行完成后重拉拓扑以获取 lastRunId，供未读标记比较；额外分页随之清除。
        queryClient.removeQueries({ queryKey: conversationsQueryKeys.moreAll })
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
        return
      }

      // 状态变化可能改变筛选归属，仅让服务端重算非 all 列表。
      queryClient.removeQueries({ predicate: (query) => filtered(query.queryKey, 'more') })
      void queryClient.invalidateQueries({
        predicate: (query) => filtered(query.queryKey, 'sidebar'),
      })
    })
  }, [connection, enabled, queryClient, userId])
}

const filtered = (queryKey: readonly unknown[], bucket: 'more' | 'sidebar') =>
  queryKey[0] === 'conversations' && queryKey[1] === bucket && queryKey.at(-1) !== 'all'

/** 在所有会话缓存里找这段对话的属主；哪份缓存都没有它时返回 undefined。 */
const ownerOf = (queryClient: QueryClient, conversationId: string): string | undefined => {
  for (const [, data] of queryClient.getQueriesData({ queryKey: conversationsQueryKeys.all })) {
    const row = findConversation(data, conversationId)
    if (row !== undefined) return row.ownerUserId
  }
  return undefined
}

const findConversation = (node: unknown, conversationId: string): Conversation | undefined => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findConversation(item, conversationId)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node === null || typeof node !== 'object') return undefined
  const fields = node as Record<string, unknown>
  if (fields['id'] === conversationId && 'activity' in fields && 'ownerUserId' in fields) {
    return node as Conversation
  }
  for (const value of Object.values(fields)) {
    const found = findConversation(value, conversationId)
    if (found !== undefined) return found
  }
  return undefined
}

/** 按 id 与 activity 识别各缓存中的会话行；未变化时保持原引用，避免无关列表重渲。 */
const patchConversation = (node: unknown, conversationId: string, patch: RowPatch): unknown => {
  if (Array.isArray(node)) {
    const next = node.map((item) => patchConversation(item, conversationId, patch))
    return next.some((item, index) => item !== node[index]) ? next : node
  }
  if (node === null || typeof node !== 'object') return node

  const fields = node as Record<string, unknown>
  if (fields['id'] === conversationId && 'activity' in fields) {
    return unchanged(fields, patch) ? node : { ...fields, ...patch }
  }

  const entries = Object.entries(fields).map(
    ([key, value]) => [key, patchConversation(value, conversationId, patch)] as const,
  )
  return entries.some(([key, value]) => value !== fields[key]) ? Object.fromEntries(entries) : node
}

const unchanged = (fields: Record<string, unknown>, patch: RowPatch): boolean => {
  if ('title' in patch) return fields['title'] === patch.title
  const current = fields['activity'] as Conversation['activity'] | undefined
  return (
    current?.busy === patch.activity.busy &&
    current.pendingInteraction === patch.activity.pendingInteraction &&
    (current.lastTurnReason ?? null) === (patch.activity.lastTurnReason ?? null)
  )
}
