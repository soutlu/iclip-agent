/** 需求单上谁能改什么、能不能开始创作；卡片与弹窗共用，规则对齐 contract/conventions.md §8。 */

import { hasPermission, PERMISSION } from '@/shared/auth'
import type { Task } from './tasks.api'

/** 当前会话用户；还没拿到或已退出时为空，一律当作没有权限。 */
type TaskActor = { id: string; permissions: readonly string[] } | null | undefined

/** 表单上按权限单独开关的字段。 */
export type TaskField =
  | 'title'
  | 'deadline'
  | 'platform'
  | 'video_type'
  | 'content_type'
  | 'resolution'
  | 'aspect_ratio'
  | 'duration_seconds'
  | 'products'
  | 'style_no'
  | 'product'
  | 'references'
  | 'creative_requirement'

/** 发布后仍可修改的字段；其余字段随发布冻结。 */
const PLANNER_EDITABLE: ReadonlySet<TaskField> = new Set([
  'title',
  'deadline',
  'creative_requirement',
  'duration_seconds',
  'aspect_ratio',
  'resolution',
  'references',
])

/** 草稿的修改与发布只归创建者本人或持 users:manage 的治理者，另要 tasks:write。 */
export const canManageDraft = (user: TaskActor, task: Task): boolean =>
  hasPermission(user, PERMISSION.tasksWrite) &&
  (user?.id === task.creatorUserId || hasPermission(user, PERMISSION.usersManage))

/** 已有需求单的某个字段此刻能不能改。新建不走这里，只看 tasks:write。 */
export const canEditTaskField = (user: TaskActor, task: Task, field: TaskField): boolean => {
  if (!hasPermission(user, PERMISSION.tasksWrite)) return false
  // 款号及其顺序在创建时定下，之后只能改每款的名称、属性和图片。
  if (field === 'style_no' || field === 'products') return false
  switch (task.status) {
    case 'draft':
      return canManageDraft(user, task)
    case 'published':
    case 'confirmed':
      return PLANNER_EDITABLE.has(field)
    case 'withdrawn':
      return false
  }
}

/** 为什么还不能从这张单开始创作；能开始时返回 null。 */
export const creationBlockReason = (user: TaskActor, task: Task | undefined): string | null => {
  if (!user || !hasPermission(user, PERMISSION.agentRun)) return '当前账号没有启动创作权限'
  if (!task) return '无法读取需求单，请返回后重试'
  switch (task.status) {
    case 'withdrawn':
      return '需求单已撤回，无法开始创作'
    case 'draft':
    case 'published':
      return '需求单尚未认领，无法开始创作'
    case 'confirmed':
      return task.assigneeUserIds.includes(user.id) ? null : '你尚未认领这张需求单，无法开始创作'
  }
}
