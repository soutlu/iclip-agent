import { useRouter } from '@tanstack/react-router'
import type { QueryFilters } from '@tanstack/react-query'
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

// SSO 整页跳转期间暂存站内返回路径。
const SSO_NEXT_STORAGE_KEY = 'cue_sso_next'

const BUSINESS_QUERIES: QueryFilters = {
  predicate: (query) => query.queryKey[0] !== 'auth',
}

/** 身份改变前丢弃旧账号的数据，也阻止尚未完成的查询重新写回缓存。 */
const clearBusinessQueries = async (): Promise<void> => {
  await queryClient.cancelQueries(BUSINESS_QUERIES)
  queryClient.removeQueries(BUSINESS_QUERIES)
}

const fetchCurrentUser = async (context?: { signal: AbortSignal }): Promise<null | CueAuthUser> => {
  let user: null | CueAuthUser
  try {
    // 登录态探测的 401 不触发全局会话复核，避免守卫递归。
    user = await getCurrentCueUser()
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error
    user = null
  }

  // 登录或退出可取消旧身份探测，迟到的响应不能清理新账号的数据。
  context?.signal.throwIfAborted()
  const previous = queryClient.getQueryData<null | CueAuthUser>(USER_QUERY_KEY)
  if ((previous?.id ?? null) !== (user?.id ?? null)) {
    await clearBusinessQueries()
  }
  context?.signal.throwIfAborted()
  return user
}

const loginWithPassword = async (request: CueLoginRequest): Promise<CueAuthUser> => {
  await loginCueUser(request)
  await queryClient.cancelQueries({ queryKey: USER_QUERY_KEY, exact: true })

  const user = await fetchCurrentUser()

  if (!user) {
    throw new ApiError(401, '登录会话未生效，请重试')
  }

  return user
}

const logout = async (): Promise<void> => {
  await logoutCueUser()
  await queryClient.cancelQueries({ queryKey: USER_QUERY_KEY, exact: true })
  await clearBusinessQueries()
}

const auth = configureAuth<null | CueAuthUser, ApiError, CueLoginRequest, CueLoginRequest>({
  loginFn: loginWithPassword,
  logoutFn: logout,
  registerFn: () => Promise.reject(new Error('Cue 不提供自助注册')),
  userFn: fetchCurrentUser,
  userKey: [...USER_QUERY_KEY],
})

export const useUser = auth.useUser

/** 路由守卫从用户缓存读取身份；无缓存时加载 /users/me。 */
export const ensureSessionUser = () =>
  queryClient.ensureQueryData({ queryFn: fetchCurrentUser, queryKey: [...USER_QUERY_KEY] })

// 登录态变化后必须 invalidate 路由，使 beforeLoad 使用最新用户缓存重算。
const useSessionInvalidation = () => {
  const router = useRouter()

  return useCallback(() => {
    void router.invalidate()
  }, [router])
}

type LoginOptions = Parameters<typeof auth.useLogin>[0]
type LogoutOptions = Parameters<typeof auth.useLogout>[0]

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

/** 使用 onSettled 重算路由，确保登出失败时也复核本地状态。 */
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

/** 强刷 /users/me 并写入缓存，供接口 401 / 403 后复核身份。 */
export const refreshSessionUser = (): Promise<null | CueAuthUser> =>
  queryClient.fetchQuery({
    queryFn: fetchCurrentUser,
    queryKey: USER_QUERY_KEY,
    staleTime: 0,
  })

export const probeSsoLoginEnabled = async (): Promise<boolean> => {
  try {
    await fetchSsoAuthorizationUrl()
    return true
  } catch {
    return false
  }
}

export const startSsoLogin = async (nextPath: string): Promise<void> => {
  const authorizationUrl = await fetchSsoAuthorizationUrl()

  try {
    sessionStorage.setItem(SSO_NEXT_STORAGE_KEY, nextPath)
  } catch {
    // 存储不可用时放弃暂存，SSO 完成后回首页。
  }

  window.location.assign(authorizationUrl)
}

export const consumeSsoNextPath = (): null | string => {
  try {
    const nextPath = sessionStorage.getItem(SSO_NEXT_STORAGE_KEY)

    sessionStorage.removeItem(SSO_NEXT_STORAGE_KEY)

    return nextPath
  } catch {
    return null
  }
}

/** 仅通过 useCompleteSsoLogin 暴露换会话流程，确保同步重算路由守卫。 */
const completeSsoLogin = async (jwt: string): Promise<CueAuthUser> => {
  await completeSsoCallback(jwt)
  await queryClient.cancelQueries({ queryKey: USER_QUERY_KEY, exact: true })

  const user = await fetchCurrentUser()

  if (!user) {
    throw new ApiError(401, 'SSO 会话未生效，请重试')
  }

  queryClient.setQueryData(USER_QUERY_KEY, user)

  return user
}

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
