/** 会话查询缓存是列表事实源；全局帧同时更新拓扑、额外分页、搜索结果与全部对话页里的匹配行。 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { useUser } from '@/shared/auth'
import type { SessionUpdate } from '@/shared/transcript/connection'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { conversationsQueryKeys, type Conversation } from './conversations.api'

/**
 * 全部对话页的重拉窗口。
 *
 * 治理者收全平台的帧，而这是个无限查询：一次失效要顺序重拉所有已展开的分页，每页后端还跑两条 COUNT。
 * 窗口尾随而不是每帧重置，持续的帧流下也能按时重拉一次。
 */
const AUDIT_REFRESH_WINDOW_MS = 1000

/** 活动帧只带轮次那三件事实，视频出片的一项保留行上原值，由重拉刷新。 */
type ActivityPatch = Omit<Conversation['activity'], 'videoGeneration'>

/** 出片帧算不出行上的汇总，能确定的只有「这活儿又动起来了」这一件。 */
type RowPatch = { title: string } | { activity: ActivityPatch } | { completedAt: null }

/** 在侧栏顶层订阅一次全局会话更新；治理者还会收到别人对话的帧。 */
export const useLiveConversations = (enabled = true): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()
  const userId = useUser().data?.id ?? null

  useEffect(() => {
    if (!enabled) return

    let auditTimer: ReturnType<typeof setTimeout> | undefined
    // 三条路共用一个出口：立刻失效与窗口到期的失效撞在一起会互相取消已发出的重拉。
    const refreshAuditSoon = () => {
      if (auditTimer !== undefined) return
      auditTimer = setTimeout(() => {
        auditTimer = undefined
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.auditAll })
      }, AUDIT_REFRESH_WINDOW_MS)
    }

    const stop = connection.watchSessions((update) => {
      if (update.kind === 'reconnected') {
        // 全局帧不支持补发；重连后丢弃额外分页并刷新拓扑与全部对话页，恢复一致状态。
        queryClient.removeQueries({ queryKey: conversationsQueryKeys.moreAll })
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
        refreshAuditSoon()
        return
      }
      if (update.kind === 'generation') {
        // 别人的对话不在自己的侧栏里，不为它改行也不为它重拉。
        const conversationId = update.conversationId
        if (conversationId === null) return
        const owner = ownerOf(queryClient, conversationId)
        if (owner !== undefined && owner !== userId) return

        // 对话里还有出片任务在动就谈不上收尾，与后端受理时抹掉标记同步（ADR-0031）。
        queryClient.setQueriesData({ queryKey: conversationsQueryKeys.all }, (data: unknown) =>
          patchConversation(data, conversationId, { completedAt: null }),
        )

        // 帧上只有单条任务的状态，行上要的是这段对话的视频汇总，算不出来就重拉；图片与切段不上侧栏。
        if (update.jobKind !== 'video') return
        // 与收场重拉同一套：丢掉额外分页，只重拉拓扑与全部对话页，不让每个已展开分页各自再请求一次。
        queryClient.removeQueries({ queryKey: conversationsQueryKeys.moreAll })
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
        refreshAuditSoon()
        return
      }

      // 补丁会盖掉行上的旧值，先按缓存里的行判断这一帧值不值得重拉。
      if (update.kind === 'activity' && needsAuditRefresh(queryClient, update)) refreshAuditSoon()

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

    return () => {
      if (auditTimer !== undefined) clearTimeout(auditTimer)
      stop()
    }
  }, [connection, enabled, queryClient, userId])
}

/**
 * 全部对话页的筛选归属与两个总数都由服务端重算，值得为这几种帧重拉：
 * 这段对话在 audit 缓存里还不存在（新对话靠重拉出现）、忙闲相对缓存翻转了、或这一帧是收尾。
 * 只有待办变化的帧行上补丁就够了。
 */
const needsAuditRefresh = (
  queryClient: QueryClient,
  update: Extract<SessionUpdate, { kind: 'activity' }>,
): boolean => {
  const cached = auditRowOf(queryClient, update.conversationId)
  if (cached === undefined) return true
  if (cached.activity.busy !== update.busy) return true
  return !update.busy && update.lastTurnReason === 'completed'
}

/** 只在全部对话页的缓存里找；侧栏有、这里没有，正是要靠重拉才出现的那种。 */
const auditRowOf = (queryClient: QueryClient, conversationId: string): Conversation | undefined => {
  for (const [, data] of queryClient.getQueriesData({
    queryKey: conversationsQueryKeys.auditAll,
  })) {
    const row = findConversation(data, conversationId)
    if (row !== undefined) return row
  }
  return undefined
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
    if (unchanged(fields, patch)) return node
    if ('title' in patch || 'completedAt' in patch) return { ...fields, ...patch }
    const current = fields['activity'] as Conversation['activity']
    // 开跑与收尾互斥，后端 touch_run 抹标记不发帧，这里照同一条不变量补上（ADR-0031）。
    return {
      ...fields,
      ...(patch.activity.busy ? { completedAt: null } : {}),
      activity: { ...current, ...patch.activity },
    }
  }

  const entries = Object.entries(fields).map(
    ([key, value]) => [key, patchConversation(value, conversationId, patch)] as const,
  )
  return entries.some(([key, value]) => value !== fields[key]) ? Object.fromEntries(entries) : node
}

const unchanged = (fields: Record<string, unknown>, patch: RowPatch): boolean => {
  if ('title' in patch) return fields['title'] === patch.title
  if ('completedAt' in patch) return fields['completedAt'] === null
  const current = fields['activity'] as Conversation['activity'] | undefined
  if (patch.activity.busy && fields['completedAt'] !== null) return false
  return (
    current?.busy === patch.activity.busy &&
    current.pendingInteraction === patch.activity.pendingInteraction &&
    (current.lastTurnReason ?? null) === (patch.activity.lastTurnReason ?? null)
  )
}
