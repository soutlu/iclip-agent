import type { ProducerAuthUser } from './producer-auth.types'

/**
 * 判断当前用户是否可以查看 Producer 生成统计页。
 *
 * UI 门控只决定入口展示与路由引导，执法在后端接口的 `analytics:read` 权限。
 *
 * @param user - 当前登录用户；缺失或未持有 `analytics:read` 权限时视为无权限。
 * @returns 持有后端 RBAC 下发的 `analytics:read` 权限时返回 true。
 */
export const canViewProducerAnalytics = (user: null | ProducerAuthUser | undefined) =>
  Boolean(user?.permissions.includes('analytics:read'))

/**
 * 判断当前用户是否可以进入项目工作台（操作页）。
 *
 * viewer 只持有只读权限，进不了操作页；执法在后端各写接口。
 *
 * @param user - 当前登录用户；缺失或未持有 `projects:write` 权限时视为无权限。
 * @returns 持有后端 RBAC 下发的 `projects:write` 权限时返回 true。
 */
export const canEditProducerProjects = (user: null | ProducerAuthUser | undefined) =>
  Boolean(user?.permissions.includes('projects:write'))

/**
 * 判断当前用户是否可以进入用户管理页（为用户配置角色/启停用）。
 *
 * UI 门控只决定入口展示与路由引导，执法在后端接口的 `users:manage` 权限。
 *
 * @param user - 当前登录用户；缺失或未持有 `users:manage` 权限时视为无权限。
 * @returns 持有后端 RBAC 下发的 `users:manage` 权限时返回 true。
 */
export const canManageProducerUsers = (user: null | ProducerAuthUser | undefined) =>
  Boolean(user?.permissions.includes('users:manage'))
