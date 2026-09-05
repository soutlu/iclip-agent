import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import { zSsoAuthorizeOut, zUserEnvelope } from '@/shared/api/generated/zod.gen'
import type { CueAuthUser, CueLoginRequest } from './cue-auth.types'

const cueMeResponseSchema = zUserEnvelope.transform((payload) => payload.user)

/** 登录、登出和 SSO 回调仅依赖状态码与 cookie 副作用。 */
const ignoredResponseSchema = z.unknown()

const ssoAuthorizeResponseSchema = zSsoAuthorizeOut.refine(
  (payload) => payload.authorization_url.trim().length > 0,
  'SSO authorize 响应缺少 authorization_url',
)

/** fastapi-users 登录使用 OAuth2 表单，成功以 204 设置 HttpOnly 会话 cookie。 */
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

export const getCurrentCueUser = async (): Promise<CueAuthUser> =>
  apiFetch('/users/me', cueMeResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取用户失败',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })

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

/** SSO 关闭时端点返回 404，供调用方探测可用性。 */
export const fetchSsoAuthorizationUrl = async (): Promise<string> => {
  const payload = await apiFetch('/auth/sso/authorize', ssoAuthorizeResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: 'SSO 登录暂不可用',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })

  return payload.authorization_url
}

export const completeSsoCallback = async (jwt: string): Promise<void> => {
  await apiFetch(`/auth/sso/callback?jwt=${encodeURIComponent(jwt)}`, ignoredResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: 'SSO 会话无效或已过期',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })
}
