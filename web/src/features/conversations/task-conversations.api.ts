import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zConversationsAuditOut, zConversationsPageOut } from '@/shared/api/generated/zod.gen'
import { drainPages } from '@/shared/api/paging'
import { auditSearchParams, DEFAULT_AUDIT_FILTERS } from './audit.api'
import { conversationsQueryKeys, type Conversation } from './conversations.api'

/** 关联对话要的是这张需求单下所有还在的对话，一次多取一些少翻几页。 */
const TASK_PAGE_LIMIT = 100

const POLL_MS = 5000

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
  return drainPages<Conversation, string>(async (cursor) => {
    const params = auditSearchParams(filters, cursor ?? null, { limit: TASK_PAGE_LIMIT })
    const page = await apiFetch(
      `/conversations/audit?${params.toString()}`,
      zConversationsAuditOut,
      options,
    )
    return { items: page.items, next: page.nextCursor }
  })
}

/** 出片这一格的进行中取值；none 之外都还没落地。 */
const VIDEO_IN_FLIGHT = new Set(['queued', 'running'])

/**
 * 还有对话在忙时才每 5 秒兜底刷新；都静下来就停手。
 *
 * 治理者那条路每轮要翻完这张需求单下的全部分页，空转的代价不小。
 */
export const taskConversationsRefetchInterval = (
  conversations: readonly Conversation[] | undefined,
): number | false =>
  (conversations ?? []).some(
    ({ activity }) => activity.busy || VIDEO_IN_FLIGHT.has(activity.videoGeneration),
  )
    ? POLL_MS
    : false

/** 面板挂载期间刷新关联关系与运行状态；不同读取权限不共享查询结果。 */
export const useTaskConversations = (taskId: string, canAudit: boolean) =>
  useQuery({
    queryKey: [...conversationsQueryKeys.all, 'task', taskId, canAudit ? 'audit' : 'own'],
    queryFn: ({ signal }) => fetchTaskConversations(taskId, canAudit, signal),
    refetchInterval: ({ state }) => taskConversationsRefetchInterval(state.data),
  })
