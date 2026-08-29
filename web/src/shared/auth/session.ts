import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { configureAuth } from 'react-query-auth'
import { ApiError } from '@/shared/api/client'
import { queryClient } from '@/shared/api/query-client'
import {
  completeSsoCallback,
  fetchSsoAuthorizationUrl,
  getCurrentCueUser,
  loginCueUser,
  logoutCueUser,
} from './cue-auth.api'
import type { CueAuthUser, CueLoginRequest } from './cue-auth.types'

// 会话唯一事实源：GET /users/me 的 TanStack Query 缓存。
export const USER_QUERY_KEY = ['auth', 'current-user'] as const

// SSO 整页跳转期间暂存站内回跳路径（替代旧 BFF 的 cue_sso_next 短时 cookie）。
const SSO_NEXT_STORAGE_KEY = 'cue_sso_next'

/**
 * 读取当前用户；未登录（401）返回 null。
 *
 * @returns 当前登录用户；未登录时返回 null。
 */
const fetchCurrentUser = async (): Promise<null | CueAuthUser> => {
  try {
    // 401 是未登录正常态，已在 API 层豁免全局跳登录（否则登录页守卫探测会死循环）。
    return await getCurrentCueUser()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null
    }

    throw error
  }
}

/**
 * 账号密码登录：种下会话 cookie 后取 /users/me 进缓存。
 *
 * @param request - 登录表单内容。
 * @returns 登录成功后的当前用户。
 */
const loginWithPassword = async (request: CueLoginRequest): Promise<CueAuthUser> => {
  await loginCueUser(request)

  const user = await fetchCurrentUser()

  if (!user) {
    throw new ApiError(401, '登录会话未生效，请重试')
  }

  return user
}

const auth = configureAuth<null | CueAuthUser, ApiError, CueLoginRequest, CueLoginRequest>({
  loginFn: loginWithPassword,
  logoutFn: logoutCueUser,
  registerFn: () => Promise.reject(new Error('Cue 不提供自助注册')),
  userFn: fetchCurrentUser,
  userKey: [...USER_QUERY_KEY],
})

/** 当前用户：纯读、无副作用，直接透传 react-query-auth 原始 hook。 */
export const useUser = auth.useUser

/**
 * 在路由守卫里取当前用户：命中缓存就直接返回，否则先把 /users/me 拉回来再放行。
 *
 * 给 beforeLoad 用——守卫不在组件里，拿不到 useUser。
 *
 * @returns 当前登录用户；未登录时返回 null。
 */
export const ensureSessionUser = () =>
  queryClient.ensureQueryData({ queryFn: fetchCurrentUser, queryKey: [...USER_QUERY_KEY] })

// 登录态变更后，路由 beforeLoad 的结果还是旧的——必须 invalidate 让所有匹配路由基于
// 新的 /users/me 缓存重算守卫。焊进每个会改登录态的 hook，调用方就「忘不掉」。
const useSessionInvalidation = () => {
  const router = useRouter()

  return useCallback(() => {
    void router.invalidate()
  }, [router])
}

type LoginOptions = Parameters<typeof auth.useLogin>[0]
type LogoutOptions = Parameters<typeof auth.useLogout>[0]

/**
 * 账号密码登录 hook：成功后自动重算路由守卫。
 *
 * @param options - 透传给底层 mutation 的选项。
 * @returns 登录 mutation。
 */
export const useLogin = (options?: LoginOptions) => {
  const invalidateSession = useSessionInvalidation()

  return auth.useLogin({
    ...options,
    onSuccess: (...args) => {
      invalidateSession()
      void options?.onSuccess?.(...args)
    },
  })
}

/**
 * 登出 hook：用 onSettled 重算守卫——接口即使失败也让本地回到未登录态评估。
 *
 * @param options - 透传给底层 mutation 的选项。
 * @returns 登出 mutation。
 */
export const useLogout = (options?: LogoutOptions) => {
  const invalidateSession = useSessionInvalidation()

  return auth.useLogout({
    ...options,
    onSettled: (...args) => {
      invalidateSession()
      void options?.onSettled?.(...args)
    },
  })
}

/**
 * 强制重新拉取 /users/me 并写入缓存（接口 401/403 说明本地身份投影可能已过期）。
 *
 * @returns 刷新后的当前用户；未登录时返回 null。
 */
export const refreshSessionUser = (): Promise<null | CueAuthUser> =>
  queryClient.fetchQuery({
    queryFn: fetchCurrentUser,
    queryKey: USER_QUERY_KEY,
    staleTime: 0,
  })

/**
 * 探测后端是否开启企业 SSO 登录（关闭时 /auth/sso/* 未挂载，404）。
 *
 * @returns SSO 可用时返回 true。
 */
export const probeSsoLoginEnabled = async (): Promise<boolean> => {
  try {
    await fetchSsoAuthorizationUrl()
    return true
  } catch {
    return false
  }
}

/**
 * 公司 SSO 第一步：暂存站内回跳路径，取授权地址并整页跳转。
 *
 * @param nextPath - SSO 完成后要回到的站内路径。
 */
export const startSsoLogin = async (nextPath: string): Promise<void> => {
  const authorizationUrl = await fetchSsoAuthorizationUrl()

  try {
    sessionStorage.setItem(SSO_NEXT_STORAGE_KEY, nextPath)
  } catch {
    // 存储不可用时放弃暂存，SSO 完成后回首页。
  }

  window.location.assign(authorizationUrl)
}

/**
 * 读取并清除 SSO 暂存的站内回跳路径。
 *
 * @returns 暂存的回跳路径；不存在或存储不可用时返回 null。
 */
export const consumeSsoNextPath = (): null | string => {
  try {
    const nextPath = sessionStorage.getItem(SSO_NEXT_STORAGE_KEY)

    sessionStorage.removeItem(SSO_NEXT_STORAGE_KEY)

    return nextPath
  } catch {
    return null
  }
}

/**
 * SSO 第二步内部实现：换会话 cookie 并填充用户缓存。
 *
 * 仅供 useCompleteSsoLogin 使用——与 login/logout 一致，只暴露「带 invalidate 收口」
 * 的 hook，杜绝裸调漏掉守卫重算。
 *
 * @param jwt - SSO 回跳携带的 jwt_token。
 * @returns 登录成功后的当前用户。
 */
const completeSsoLogin = async (jwt: string): Promise<CueAuthUser> => {
  await completeSsoCallback(jwt)

  const user = await fetchCurrentUser()

  if (!user) {
    throw new ApiError(401, 'SSO 会话未生效，请重试')
  }

  queryClient.setQueryData(USER_QUERY_KEY, user)

  return user
}

/**
 * 公司 SSO 第二步（落地页用）：换会话 cookie 后自动重算路由守卫。
 *
 * @returns 稳定的提交函数，接收 jwt 并返回登录后的用户。
 */
export const useCompleteSsoLogin = (): ((jwt: string) => Promise<CueAuthUser>) => {
  const invalidateSession = useSessionInvalidation()

  return useCallback(
    async (jwt: string) => {
      const user = await completeSsoLogin(jwt)

      invalidateSession()

      return user
    },
    [invalidateSession],
  )
}
