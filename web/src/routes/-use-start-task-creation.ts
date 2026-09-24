import { useNavigate } from '@tanstack/react-router'
import { useConversationAgents, useStartConversation } from '@/features/conversations'
import type { TaskCreationStarter } from '@/features/tasks'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'

/**
 * 在路由层连接需求单与对话：名册与首页同一份 Agent 目录，开始时把预览里确认的消息和选中的 Agent
 * 交给起步原语，成功后进对话页；重试与幂等由原语负责。
 */
export function useStartTaskCreation(): TaskCreationStarter {
  const navigate = useNavigate()
  const { data: user } = useUser()
  const agents = useConversationAgents(hasPermission(user, PERMISSION.agentRun))
  const start = useStartConversation(user?.id ?? null, (conversationId) => {
    void navigate({ params: { conversationId }, to: '/c/$conversationId' })
  })

  return {
    agents: {
      items: agents.data?.items,
      pending: agents.isPending,
      error: agents.error,
      retry: () => void agents.refetch(),
    },
    start: async (draft, agentId) => {
      await start.mutateAsync({
        agentId,
        content: draft.content,
        taskId: draft.taskId,
        title: draft.title,
      })
    },
  }
}
