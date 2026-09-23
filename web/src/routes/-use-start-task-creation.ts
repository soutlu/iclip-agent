import { useNavigate } from '@tanstack/react-router'
import { STORYBOARD_AGENT_ID, useStartConversation } from '@/features/conversations'
import type { TaskCreationDraft } from '@/features/tasks'
import { useUser } from '@/shared/auth'

/** 在路由层连接需求单与对话：把预览里确认的那份消息交给起步原语，成功后进对话页；重试与幂等由原语负责。 */
export function useStartTaskCreation() {
  const navigate = useNavigate()
  const userId = useUser().data?.id ?? null
  const start = useStartConversation(userId, (conversationId) => {
    void navigate({ params: { conversationId }, to: '/c/$conversationId' })
  })

  return async (draft: TaskCreationDraft): Promise<void> => {
    await start.mutateAsync({
      agentId: STORYBOARD_AGENT_ID,
      content: draft.content,
      taskId: draft.taskId,
      title: draft.title,
    })
  }
}
