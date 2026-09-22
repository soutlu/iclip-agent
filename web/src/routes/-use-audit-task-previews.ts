import { useQueries } from '@tanstack/react-query'
import { listTasksByIds, taskPreviewOf, tasksQueryKeys, type Task } from '@/features/tasks'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'

/**
 * 关联到的需求单按 id 批量读取，一组一个请求；读取失败不视作未关联。
 *
 * 分组按对话列表的页来：再翻一页只多一组、已有各组的键不变，已读到的预览不会因为新页到来而闪一下；
 * 一组读失败也只影响那一页的行。一页最多 50 段对话，不会超过接口一次 100 个 id 的上限。
 */
export function useAuditTaskPreviews(taskIdGroups: readonly (readonly string[])[]): {
  taskPreviews: ReadonlyMap<string, TaskPreview>
  taskPreviewState: TaskPreviewState
  taskPreviewRetry: () => void
} {
  const { data: user } = useUser()
  const canReadTasks = hasPermission(user, PERMISSION.tasksRead)
  const groups = taskIdGroups.map((ids) => [...new Set(ids)].sort()).filter((ids) => ids.length > 0)
  const batches = useQueries({
    queries: groups.map((ids) => ({
      enabled: canReadTasks,
      queryFn: ({ signal }: { signal: AbortSignal }) => listTasksByIds(ids, signal),
      queryKey: tasksQueryKeys.byIds(ids),
    })),
  })

  const tasks = new Map<string, Task>()
  for (const batch of batches) {
    for (const task of batch.data ?? []) tasks.set(task.id, task)
  }

  let taskPreviewState: TaskPreviewState = 'ready'
  if (!canReadTasks) taskPreviewState = 'forbidden'
  else if (batches.some((batch) => batch.isError)) taskPreviewState = 'error'
  else if (batches.some((batch) => batch.isPending)) taskPreviewState = 'loading'

  return {
    taskPreviews: canReadTasks
      ? new Map([...tasks].map(([id, task]) => [id, taskPreviewOf(task)]))
      : new Map(),
    taskPreviewState,
    taskPreviewRetry: () => {
      for (const batch of batches) {
        if (batch.isError) void batch.refetch()
      }
    },
  }
}
