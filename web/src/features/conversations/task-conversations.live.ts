/** 需求单关联对话列表按全局帧重拉：列表里的对话有视频任务跳格、或连接重连时。 */

import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import type { Conversation } from './conversations.api'
import { taskConversationsQueryKey } from './task-conversations.api'

/**
 * 面板挂载期间订阅；行上的出片汇总帧里算不出来，只能重拉。
 *
 * 活动与标题帧已由 useLiveConversations 补到这份缓存的行上，这里不再处理。
 */
export const useLiveTaskConversations = (taskId: string, canAudit: boolean): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveTaskConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()

  useEffect(() => {
    const queryKey = taskConversationsQueryKey(taskId, canAudit)
    // 不并进 useLiveConversations 的生成分支：那边先按属主拦下别人的对话，治理者看别人的单子就刷不到。
    return connection.watchSessions((update) => {
      if (update.kind === 'reconnected') {
        // 全局帧不补发，重连后对齐一次。
        void queryClient.invalidateQueries({ queryKey })
        return
      }
      if (update.kind !== 'generation' || update.jobKind !== 'video') return
      const { conversationId } = update
      if (conversationId === null) return
      // 帧只发给属主与治理者，列表里有这段对话就说明与这张单相关。
      const listed = queryClient
        .getQueryData<Conversation[]>(queryKey)
        ?.some(({ id }) => id === conversationId)
      if (listed === true) void queryClient.invalidateQueries({ queryKey })
    })
  }, [canAudit, connection, queryClient, taskId])
}
