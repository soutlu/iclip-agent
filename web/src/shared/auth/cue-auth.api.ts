import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import { zSsoAuthorizeOut, zUserEnvelope } from '@/shared/api/generated/zod.gen'
import type { CueAuthUser, CueLoginRequest } from './cue-auth.types'

/** 后端 `/users/me` 响应是 `{ user }` 包装，形状取自生成契约。 */
const cueMeResponseSchema = zUserEnvelope.transform((payload) => payload.user)

/** 忽略响应体的端点（登录/登出/SSO callback 只关心状态码与 cookie 副作用）。 */
const ignoredResponseSchema = z.unknown()

/** 后端 `/auth/sso/authorize` 响应：形状取自生成契约，只补一条「非空」的业务约束。 */
const ssoAuthorizeResponseSchema = zSsoAuthorizeOut.refine(
  (payload) => payload.authorization_url.trim().length > 0,
  'SSO authorize 响应缺少 authorization_url',
)

/**
 * 使用用户名和密码登录 Cue。
 *
 * 后端 fastapi-users 接收 OAuth2 表单，成功返回 204 并种下 HttpOnly 会话 cookie。
 *
 * @param request - Cue 登录表单提交内容。
 */
export const loginCueUser = async (request: CueLoginRequest): Promise<void> => {
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
 * 读取当前 Cue 登录用户。
 *
 * @returns 当前会话 cookie 对应的用户信息。
 * @throws 未登录（401）或响应结构非法时抛出错误。
 */
export const getCurrentCueUser = async (): Promise<CueAuthUser> =>
  apiFetch('/users/me', cueMeResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取用户失败',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })

/**
 * 退出当前 Cue 登录态（后端注销会话并清 cookie）。
 */
export const logoutCueUser = async (): Promise<void> => {
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
