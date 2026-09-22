import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zConversationsAuditOut, zConversationsPageOut } from '@/shared/api/generated/zod.gen'
import { auditSearchParams, DEFAULT_AUDIT_FILTERS } from './audit.api'
import { conversationsQueryKeys, type Conversation } from './conversations.api'

/** 关联对话要的是这张需求单下所有还在的对话，一次多取一些少翻几页。 */
const TASK_PAGE_LIMIT = 100

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

  const filters = {
    ...DEFAULT_AUDIT_FILTERS,
    deleted: 'live' as const,
    range: 'all' as const,
    taskId,
  }
  const conversations: Conversation[] = []
  let cursor: string | null = null
  do {
    const params = auditSearchParams(filters, cursor, { limit: TASK_PAGE_LIMIT })
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
