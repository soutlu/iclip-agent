import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useRef } from 'react'
import {
  conversationsQueryKeys,
  createConversation,
  mintPromptId,
  submitPrompt,
} from '@/features/conversations'
import type { TaskCreationDraft } from '@/features/tasks'

type CreationAttempt = {
  draft: TaskCreationDraft
  conversationId: string | null
  promptId: string
  inFlight: Promise<void> | null
}

/** 在路由层连接需求单与对话；同一份预览重试时沿用已创建的对话和首次消息。 */
export function useStartTaskCreation() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const currentRef = useRef<CreationAttempt | null>(null)

  return async (draft: TaskCreationDraft): Promise<void> => {
    if (currentRef.current?.draft !== draft) {
      currentRef.current = { draft, conversationId: null, promptId: mintPromptId(), inFlight: null }
    }
    const attempt = currentRef.current
    if (attempt.inFlight) return attempt.inFlight

    const send = async () => {
      if (attempt.conversationId === null) {
        const conversation = await createConversation({
          agentId: 'storyboard',
          taskId: draft.taskId,
          title: draft.title,
        })
        attempt.conversationId = conversation.id
        // 即使首次消息发送失败，也让用户能够从侧栏找到已创建的对话。
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
      }
      await submitPrompt(attempt.conversationId, {
        content: attempt.draft.content,
        promptId: attempt.promptId,
      })
      void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
      await navigate({
        params: { conversationId: attempt.conversationId },
        to: '/c/$conversationId',
      })
    }

    attempt.inFlight = send().finally(() => {
      attempt.inFlight = null
    })
    return attempt.inFlight
  }
}
