/** 生成任务状态跳转帧到了就重拉本对话的生成查询；轮询保留为兜底（contract/conventions.md §5、§11）。 */

import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { imageEditConversationKey } from './image-edit/image-edit.api'
import { storyboardQueryKeys } from './storyboard.api'

export const useLiveGenerations = (conversationId: string): void => {
  const connection = use(TranscriptConnectionContext)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchSessions((update) => {
      // 全局帧不补发，重连后同样重拉，补偿断线期间丢失的跳转。
      const relevant =
        update.kind === 'reconnected' ||
        (update.kind === 'generation' && update.conversationId === conversationId)
      if (!relevant) return
      void queryClient.invalidateQueries({
        queryKey: storyboardQueryKeys.generations(conversationId),
      })
      void queryClient.invalidateQueries({ queryKey: imageEditConversationKey(conversationId) })
    })
  }, [connection, conversationId, queryClient])
}
