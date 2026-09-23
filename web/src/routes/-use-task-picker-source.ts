/** 需求单选择器的候选在路由层取：conversations、audit 与 tasks 几个 feature 不直接互引；没有 tasks:read 就不问，返回 null 让选择器不出现。 */

import { useTaskOptions } from '@/features/tasks'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import type { PickerSource } from '@/shared/ui/search-picker'

export function useTaskPickerSource(): PickerSource | null {
  const { data: user } = useUser()
  const canReadTasks = hasPermission(user, PERMISSION.tasksRead)
  const tasks = useTaskOptions(canReadTasks)
  if (!canReadTasks) return null
  return {
    error: tasks.isError ? errorMessageOf(tasks.error, '读取需求单列表失败') : undefined,
    isPending: tasks.isPending,
    onRetry: () => void tasks.refetch(),
    options: tasks.data ?? [],
  }
}
