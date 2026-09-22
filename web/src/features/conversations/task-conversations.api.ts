import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zConversationsAuditOut, zConversationsPageOut } from '@/shared/api/generated/zod.gen'
import { conversationsQueryKeys, type Conversation } from './conversations.api'

/** 普通用户读取自己的创作尝试；治理者逐页读取需求单下未删除的全部对话。 */
export const fetchTaskConversations = async (
  taskId: string,
  canAudit: boolean,
  signal: AbortSignal,
): Promise<Conversation[]> => {
  const options = {
    cache: 'no-store' as const,
    fallbackErrorMessage: '读取关联对话失败',
    signal,
  }
  if (!canAudit) {
    const page = await apiFetch(
      `/conversations/by-task/${encodeURIComponent(taskId)}`,
      zConversationsPageOut,
      options,
    )
    return page.items
  }

  const params = new URLSearchParams({ taskId, deleted: 'live', limit: '100' })
  const conversations: Conversation[] = []
  let cursor: string | null = null
  do {
    if (cursor !== null) params.set('cursor', cursor)
    const page = await apiFetch(
      `/conversations/audit?${params.toString()}`,
      zConversationsAuditOut,
      options,
    )
    conversations.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null)
  return conversations
}

/** 面板挂载期间刷新关联关系与运行状态；不同读取权限不共享查询结果。 */
export const useTaskConversations = (taskId: string, canAudit: boolean) =>
  useQuery({
    queryKey: [...conversationsQueryKeys.all, 'task', taskId, canAudit ? 'audit' : 'own'],
    queryFn: ({ signal }) => fetchTaskConversations(taskId, canAudit, signal),
    refetchInterval: 5000,
  })
