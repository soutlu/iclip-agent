/**
 * 侧栏那些行的实时更新：**查询缓存就是会话表**（照 kimi 网页版）。
 *
 * 全局帧到了就地改缓存里那一行，不重拉列表——同一份事实本来就长在行上，帧只负责「不必等
 * 下一次重拉」。一份补丁同时落到三处缓存（侧栏拓扑、「展开显示」取回的页、搜索结果）：认行
 * 靠按结构递归找那一行，而不是分别认识三种外层形状。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { use, useEffect } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { conversationsQueryKeys, type Conversation } from './conversations.api'
import { markUnread } from './conversations.unread'

/** 打在一行上的补丁：改名那一帧只带名字，活儿那一帧只带活儿。 */
type RowPatch = { title: string } | { activity: Conversation['activity'] }

/**
 * 订上全局帧，把改名与活儿写进查询缓存，跑完而人不在场的记一笔未读。在侧栏顶层调一次。
 */
export const useLiveConversations = (): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()
  const router = useRouter()

  useEffect(
    () =>
      connection.watchSessions((update) => {
        if (update.kind === 'reconnected') {
          // 帧是易失的：断线期间的改名与收场谁也补不回来。「展开显示」取回的那些页整个丢掉
          // （列表收回第一页），拓扑重拉一次就把两边对齐了。
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

        // 一轮跑完而人不在这段对话上，记一笔未读。这一帧只在活儿真的转了状态时才到（连上、
        // 重拉都不发），所以「刚才是不是在跑」不必另外记一份；开着哪一段在帧到达时从路由现读，
        // 而不是订阅时记下来——慢一步读到的是上一个页面，正好错在人刚离开那一段的时候。
        if (!update.busy && update.lastTurnReason === 'completed') {
          const here = router.matchRoute({
            params: { conversationId: update.conversationId },
            to: '/c/$conversationId',
          })
          if (here === false) markUnread(update.conversationId)
        }

        // 活儿变了，这一行可能该从当前筛选里进来或出去，算得准的只有服务端。筛「全部」时不必。
        queryClient.removeQueries({ predicate: (query) => filtered(query.queryKey, 'more') })
        void queryClient.invalidateQueries({
          predicate: (query) => filtered(query.queryKey, 'sidebar'),
        })
      }),
    [connection, queryClient, router],
  )
}

/** 这条查询是不是某一档「非全部」筛选下的那段列表。 */
const filtered = (queryKey: readonly unknown[], bucket: 'more' | 'sidebar') =>
  queryKey[0] === 'conversations' && queryKey[1] === bucket && queryKey.at(-1) !== 'all'

/**
 * 把补丁打到 `conversationId` 那一行上。认行的判据是「id 对得上、身上有 activity」——三处缓存
 * 的外层形状各不相同，但那一行长一个样。
 *
 * **没改到任何东西时返回原引用**：每一帧都造一份新数据的话，所有列着的列表都要重渲一遍。
 */
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

/** 这一行身上已经是补丁里的值：同一份活儿再推一遍不该让列表重渲。 */
const unchanged = (fields: Record<string, unknown>, patch: RowPatch): boolean => {
  if ('title' in patch) return fields['title'] === patch.title
  const current = fields['activity'] as Conversation['activity'] | undefined
  return (
    current?.busy === patch.activity.busy &&
    current.pendingInteraction === patch.activity.pendingInteraction &&
    (current.lastTurnReason ?? null) === (patch.activity.lastTurnReason ?? null)
  )
}
