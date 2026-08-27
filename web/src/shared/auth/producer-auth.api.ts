import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import { zSsoAuthorizeOut } from '@/shared/api/generated/zod.gen'
import { isRecord } from '@/shared/lib/guards'
import type { ProducerAuthUser, ProducerLoginRequest } from './producer-auth.types'

const producerDepartmentSchema = z.object({
  id: z.number().int(),
  uid: z.string(),
  name: z.string(),
  parentId: z.number().int().nullable(),
  parentUid: z.string(),
  leaderUserId: z.number().int().nullable(),
  leaderUserUid: z.string(),
  source: z.string(),
  type: z.string(),
  order: z.number().int().nullable(),
})

/**
 * 从未知对象中读取非空字符串字段。
 *
 * @param record - 已校验的普通对象。
 * @param field - 需要读取的字段名。
 * @returns 字段值是非空字符串时返回字符串，否则返回 null。
 */
const readNonEmptyString = (record: Record<string, unknown>, field: string) => {
  const value = record[field]

  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  return value
}

/**
 * 从未知对象中读取字符串数组字段。
 *
 * @param record - 已校验的普通对象。
 * @param field - 需要读取的字段名。
 * @returns 字段是数组时返回其中的字符串项，否则返回空数组。
 */
const readStringArray = (record: Record<string, unknown>, field: string): string[] => {
  const value = record[field]

  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string')
}

/** 从 `/users/me` 读取完整部门数组。 */
const readDepartments = (record: Record<string, unknown>) => {
  const parsed = z.array(producerDepartmentSchema).safeParse(record['departments'])
  return parsed.success ? parsed.data : []
}

/**
 * 从未知值中解析认证用户对象。
 *
 * SSO 首登自动建号的用户没有 username，此时展示信息回退到 displayName，
 * 因此只有 id 是硬性要求。roles/permissions 缺失时按无任何权限处理。
 *
 * @param payload - 后端返回的 user 字段。
 * @returns 符合前端契约的认证用户。
 * @throws 当 user 字段结构不符合约定时抛出错误。
 */
export const parseProducerAuthUser = (payload: unknown): ProducerAuthUser => {
  if (!isRecord(payload)) {
    throw new Error('认证用户响应格式无效')
  }

  const id = readNonEmptyString(payload, 'id')

  if (!id) {
    throw new Error('认证用户响应格式无效')
  }

  const user: ProducerAuthUser = {
    avatarUrl: readNonEmptyString(payload, 'avatarUrl') ?? '',
    displayName: readNonEmptyString(payload, 'displayName') ?? '',
    id,
    permissions: readStringArray(payload, 'permissions'),
    roles: readStringArray(payload, 'roles'),
    username: readNonEmptyString(payload, 'username'),
  }

  if (typeof payload['city'] === 'string') {
    user.city = readNonEmptyString(payload, 'city') ?? ''
  }
  if (typeof payload['jobTitle'] === 'string') {
    user.jobTitle = readNonEmptyString(payload, 'jobTitle') ?? ''
  }
  if (Array.isArray(payload['departments'])) {
    user.departments = readDepartments(payload)
  }

  return user
}

/** 后端 `/users/me` 响应（`{user: {...}}` 包装）；user 字段的容错解析沿用 parseProducerAuthUser。 */
const producerMeResponseSchema = z
  .object({ user: z.unknown() }, { error: '当前用户响应格式无效' })
  .transform((payload) => parseProducerAuthUser(payload.user))

/** 忽略响应体的端点（登录/登出/SSO callback 只关心状态码与 cookie 副作用）。 */
const ignoredResponseSchema = z.unknown()

/** 后端 `/auth/sso/authorize` 响应：形状取自生成契约，只补一条「非空」的业务约束。 */
const ssoAuthorizeResponseSchema = zSsoAuthorizeOut.refine(
  (payload) => payload.authorization_url.trim().length > 0,
  'SSO authorize 响应缺少 authorization_url',
)

/**
 * 使用用户名和密码登录 Producer。
 *
 * 后端 fastapi-users 接收 OAuth2 表单，成功返回 204 并种下 HttpOnly 会话 cookie。
 *
 * @param request - Producer 登录表单提交内容。
 */
export const loginProducerUser = async (request: ProducerLoginRequest): Promise<void> => {
  await apiFetch('/auth/login', ignoredResponseSchema, {
    body: new URLSearchParams({
      password: request.password,
      username: request.username,
    }),
    fallbackErrorMessage: '登录失败',
    method: 'POST',
    skipUnauthorizedHandler: true,
  })
}

/**
 * 读取当前 Producer 登录用户。
 *
 * @returns 当前会话 cookie 对应的用户信息。
 * @throws 未登录（401）或响应结构非法时抛出错误。
 */
export const getCurrentProducerUser = async (): Promise<ProducerAuthUser> =>
  apiFetch('/users/me', producerMeResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取用户失败',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })

/**
 * 退出当前 Producer 登录态（后端注销会话并清 cookie）。
 */
export const logoutProducerUser = async (): Promise<void> => {
  try {
    await apiFetch('/auth/logout', ignoredResponseSchema, {
      fallbackErrorMessage: '退出登录失败',
      method: 'POST',
      skipUnauthorizedHandler: true,
    })
  } catch (error) {
    // 会话本就已失效时后端返回 401，视为登出成功。
    if (!(error instanceof ApiError && error.status === 401)) {
      throw error
    }
  }
}

/**
 * 获取企业 SSO 授权跳转地址。
 *
 * 后端 SSO 关闭时不挂 `/auth/sso/*` 路由（404），调用方可据此探测可用性。
 *
 * @returns SSO 服务的授权页地址。
 * @throws SSO 不可用或响应结构非法时抛出错误。
 */
export const fetchSsoAuthorizationUrl = async (): Promise<string> => {
  const payload = await apiFetch('/auth/sso/authorize', ssoAuthorizeResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: 'SSO 登录暂不可用',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })

  return payload.authorization_url
}

/**
 * 用 SSO 回跳的 jwt 向后端换取自有会话 cookie。
 *
 * @param jwt - SSO 服务回跳携带的 jwt_token。
 */
export const completeSsoCallback = async (jwt: string): Promise<void> => {
  await apiFetch(`/auth/sso/callback?jwt=${encodeURIComponent(jwt)}`, ignoredResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: 'SSO 会话无效或已过期',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })
}
