/** 会话查询缓存是列表事实源；全局帧同时更新拓扑、额外分页与搜索结果中的匹配行。 */

import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { conversationsQueryKeys, type Conversation } from './conversations.api'

type RowPatch = { title: string } | { activity: Conversation['activity'] }

/** 在侧栏顶层订阅一次全局会话更新。 */
export const useLiveConversations = (): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()

  useEffect(
    () =>
      connection.watchSessions((update) => {
        if (update.kind === 'reconnected') {
          // 全局帧不支持补发；重连后丢弃额外分页并刷新拓扑，恢复一致状态。
          queryClient.removeQueries({ queryKey: ['conversations', 'more'] })
          void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
          return
        }

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

        if (!update.busy && update.lastTurnReason === 'completed') {
          // 运行完成后重拉拓扑以获取 lastRunId，供未读标记比较；额外分页随之清除。
          queryClient.removeQueries({ queryKey: ['conversations', 'more'] })
          void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
          return
        }

        // 状态变化可能改变筛选归属，仅让服务端重算非 all 列表。
        queryClient.removeQueries({ predicate: (query) => filtered(query.queryKey, 'more') })
        void queryClient.invalidateQueries({
          predicate: (query) => filtered(query.queryKey, 'sidebar'),
        })
      }),
    [connection, queryClient],
  )
}

const filtered = (queryKey: readonly unknown[], bucket: 'more' | 'sidebar') =>
  queryKey[0] === 'conversations' && queryKey[1] === bucket && queryKey.at(-1) !== 'all'

/** 按 id 与 activity 识别三种缓存中的会话行；未变化时保持原引用，避免无关列表重渲。 */
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
