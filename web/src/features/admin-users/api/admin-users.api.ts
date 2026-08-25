import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { isRecord } from '@/shared/lib/guards'

/** 后端 RBAC 支持的角色，与 rbac.ROLE_PERMISSIONS 的键一致；发未知角色后端返 400。 */
export type AdminUserRoleId = 'editor' | 'root' | 'viewer'

export type AdminUserRoleOption = {
  id: AdminUserRoleId
  label: string
}

export const ADMIN_USER_ROLE_OPTIONS: AdminUserRoleOption[] = [
  { id: 'root', label: '超级管理员' },
  { id: 'editor', label: '编辑者' },
  { id: 'viewer', label: '查看者' },
]

export type AdminUser = {
  id: string
  // SSO 首登自动建号的用户没有 username，展示时回退到 displayName/email。
  username: null | string
  email: string
  displayName: string
  avatarUrl: string
  roles: string[]
  isActive: boolean
  createdAt: string
  lastLoginAt: null | string
}

export type AdminUsersPage = {
  items: AdminUser[]
  total: number
  page: number
  pageSize: number
}

export type AdminUserPatch = {
  roles?: AdminUserRoleId[]
  isActive?: boolean
}

/**
 * 从响应对象中读取字符串字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @returns 字符串字段值；缺失或非字符串时返回空串。
 */
const readString = (record: Record<string, unknown>, field: string) => {
  const value = record[field]

  return typeof value === 'string' ? value : ''
}

/**
 * 从响应对象中读取可空字符串字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @returns 非空字符串时返回原值，否则返回 null。
 */
const readNullableString = (record: Record<string, unknown>, field: string) => {
  const value = record[field]

  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 从响应对象中读取字符串数组字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @returns 字段是数组时返回其中的字符串项，否则返回空数组。
 */
const readStringArray = (record: Record<string, unknown>, field: string): string[] => {
  const value = record[field]

  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 解析用户管理接口返回的单个用户。
 *
 * 只授了直接权限、没分配角色的账号 roles 为空数组，属正常态，不做非空要求。
 *
 * @param payload - 后端返回的用户对象。
 * @returns 符合前端契约的用户。
 * @throws 当缺少 id/isActive 等关键字段时抛出错误。
 */
export const parseAdminUser = (payload: unknown): AdminUser => {
  if (!isRecord(payload)) {
    throw new Error('用户响应格式无效')
  }

  const id = readNullableString(payload, 'id')
  const isActive = payload.isActive

  if (!id || typeof isActive !== 'boolean') {
    throw new Error('用户响应格式无效')
  }

  return {
    avatarUrl: readString(payload, 'avatarUrl'),
    createdAt: readString(payload, 'createdAt'),
    displayName: readString(payload, 'displayName'),
    email: readString(payload, 'email'),
    id,
    isActive,
    lastLoginAt: readNullableString(payload, 'lastLoginAt'),
    roles: readStringArray(payload, 'roles'),
    username: readNullableString(payload, 'username'),
  }
}

/** 后端 `/users` 分页响应；page/total 等字段容错回退，item 结构由 parseAdminUser 收口。 */
const adminUsersPageSchema = z.looseObject(
  { items: z.array(z.unknown(), { error: '用户列表响应格式无效' }) },
  { error: '用户列表响应格式无效' },
)

/** 后端 `/users/{id}` PATCH 响应（`{user: {...}}` 包装）。 */
const adminUserResponseSchema = z
  .object({ user: z.unknown() }, { error: '用户响应格式无效' })
  .transform((payload) => parseAdminUser(payload.user))

/**
 * 分页拉取用户列表（后端 `users:manage` 权限门控）。
 *
 * @param params - 分页参数（page 从 1 开始）。
 * @param signal - 请求取消信号。
 * @returns 当前页用户与分页信息。
 * @throws 无权限（403）、未登录（401）或响应结构非法时抛出错误。
 */
export const fetchAdminUsersPage = async (
  params: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<AdminUsersPage> => {
  const searchParams = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  })
  const payload = await apiFetch(`/users?${searchParams.toString()}`, adminUsersPageSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '加载用户列表失败',
    method: 'GET',
    signal,
  })

  return {
    items: payload.items.map(parseAdminUser),
    page: typeof payload.page === 'number' ? payload.page : params.page,
    pageSize: typeof payload.pageSize === 'number' ? payload.pageSize : params.pageSize,
    total: typeof payload.total === 'number' ? payload.total : payload.items.length,
  }
}

/**
 * 管理员调整用户角色/启停用（后端 `users:manage` 权限门控）。
 *
 * roles 是整体替换语义：传什么就是这个用户之后的全部角色。
 * 后端业务规则：不能改自己的授权、不能停用自己（违反时返回带文案的 400）。
 *
 * @param userId - 目标用户 id。
 * @param patch - 要调整的字段；未提供的字段保持不变。
 * @returns 更新后的用户。
 * @throws 后端拒绝（未知角色、改自己的授权、自停用）或响应结构非法时抛出错误。
 */
export const updateAdminUser = async (
  userId: string,
  patch: AdminUserPatch,
): Promise<AdminUser> => {
  const body: Record<string, unknown> = {}

  if (patch.roles !== undefined) {
    body.roles = patch.roles
  }

  if (patch.isActive !== undefined) {
    body.isActive = patch.isActive
  }

  return apiFetch(`/users/${encodeURIComponent(userId)}`, adminUserResponseSchema, {
    body,
    fallbackErrorMessage: '更新用户失败',
    method: 'PATCH',
  })
}
