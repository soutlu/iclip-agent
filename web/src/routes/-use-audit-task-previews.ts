import { useQueries, useQuery } from '@tanstack/react-query'
import { getTask, listAllTasks, taskPreviewOf, tasksQueryKeys } from '@/features/tasks'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'

/** 复用需求单列表缓存；历史需求单按本页关联 ID 去重补取，不将读取失败视作未关联。 */
export function useAuditTaskPreviews(taskIds: readonly string[]): {
  taskPreviews: ReadonlyMap<string, TaskPreview>
  taskPreviewState: TaskPreviewState
  taskPreviewRetry: () => void
} {
  const { data: user } = useUser()
  const canReadTasks = hasPermission(user, PERMISSION.tasksRead)
  const list = useQuery({
    enabled: canReadTasks,
    queryFn: ({ signal }) => listAllTasks(signal),
    queryKey: tasksQueryKeys.list('all'),
  })
  const tasks = new Map((list.data ?? []).map((task) => [task.id, task]))
  const missingIds = [...new Set(taskIds)].filter((id) => !tasks.has(id))
  const details = useQueries({
    queries: missingIds.map((id) => ({
      enabled: canReadTasks && !list.isPending,
      queryFn: ({ signal }: { signal: AbortSignal }) => getTask(id, signal),
      queryKey: tasksQueryKeys.detail(id),
    })),
  })
  for (const detail of details) {
    if (detail.data) tasks.set(detail.data.id, detail.data)
  }

  let taskPreviewState: TaskPreviewState = 'ready'
  if (!canReadTasks) taskPreviewState = 'forbidden'
  else if (list.isError || details.some((detail) => detail.isError)) taskPreviewState = 'error'
  else if (list.isPending || details.some((detail) => detail.isPending))
    taskPreviewState = 'loading'

  return {
    taskPreviews: canReadTasks
      ? new Map([...tasks].map(([id, task]) => [id, taskPreviewOf(task)]))
      : new Map(),
    taskPreviewState,
    taskPreviewRetry: () => {
      if (list.isError) void list.refetch()
      for (const detail of details) {
        if (detail.isError) void detail.refetch()
      }
    },
  }
}
