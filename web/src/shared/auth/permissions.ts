/** 权限词表：后端 `user.permissions` 里的字符串只在这里写一次，判定也只走这里的函数。 */

export const PERMISSION = {
  agentRead: 'agent:read',
  agentRun: 'agent:run',
  collectionsRead: 'collections:read',
  collectionsWrite: 'collections:write',
  generationRead: 'generation:read',
  generationSubmit: 'generation:submit',
  inspirationsRead: 'inspirations:read',
  tasksRead: 'tasks:read',
  tasksWrite: 'tasks:write',
  uploadsWrite: 'uploads:write',
  usersManage: 'users:manage',
} as const

export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION]

/** 会话还没拿到或已退出时一律没有权限，调用方不必先判空。 */
type PermissionHolder = { permissions: readonly string[] } | null | undefined

export const hasPermission = (user: PermissionHolder, permission: Permission): boolean =>
  user?.permissions.includes(permission) ?? false

/** 看别人的对话：全部对话与审计的接口同时要 users:manage 与 agent:read（合同 §6、§12）。 */
export const canAuditAll = (user: PermissionHolder): boolean =>
  hasPermission(user, PERMISSION.usersManage) && hasPermission(user, PERMISSION.agentRead)
