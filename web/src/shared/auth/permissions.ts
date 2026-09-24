/** 前端用到的权限：取值受合同 `Permission` 约束，判定只走这里的函数。 */

import type { Permission as ContractPermission } from '@/shared/api/generated/types.gen'

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
} as const satisfies Record<string, ContractPermission>

export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION]

/** 会话还没拿到或已退出时一律没有权限，调用方不必先判空。 */
type PermissionHolder = { permissions: readonly string[] } | null | undefined

export const hasPermission = (user: PermissionHolder, permission: Permission): boolean =>
  user?.permissions.includes(permission) ?? false

/** 看别人的对话：全部对话接口要 users:manage 与 agent:read，审计报表只要 users:manage，这里合起来判；各端点权限见合同 openapi 的 `security`。 */
export const canAuditAll = (user: PermissionHolder): boolean =>
  hasPermission(user, PERMISSION.usersManage) && hasPermission(user, PERMISSION.agentRead)
