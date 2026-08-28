import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  consumeSsoNextPath,
  sanitizeProducerAuthNextPath,
  useCompleteSsoLogin,
} from '@/shared/auth'

type SsoLandingPageProps = {
  jwt?: string | undefined
}

/**
 * 把 SSO 换会话失败映射为登录页可读的错误码。
 *
 * @param error - completeSsoLogin 抛出的未知错误。
 * @returns 登录页 ?ssoError= 错误码。
 */
const ssoErrorCodeFromError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) {
    return 'invalid'
  }

  if (error instanceof ApiError && error.status === 403) {
    return 'forbidden'
  }

  return 'unavailable'
}

/**
 * 渲染企业 SSO 回跳落地页：用 jwt 换自有会话后回到暂存的站内路径。
 *
 * @param props - 落地页属性。
 * @param props.jwt - SSO 服务回跳携带的 jwt_token。
 * @returns SSO 落地过渡页。
 */
export function SsoLandingPage({ jwt }: SsoLandingPageProps) {
  const navigate = useNavigate()
  const completeSsoLogin = useCompleteSsoLogin()
  // StrictMode 下 effect 双跑，jwt 只允许换发一次会话。
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) {
      return
    }

    startedRef.current = true

    if (!jwt) {
      void navigate({ replace: true, search: { ssoError: 'missing' }, to: '/login' })
      return
    }

    completeSsoLogin(jwt)
      .then(() => {
        void navigate({ replace: true, to: sanitizeProducerAuthNextPath(consumeSsoNextPath()) })
      })
      .catch((error: unknown) => {
        void navigate({
          replace: true,
          search: { ssoError: ssoErrorCodeFromError(error) },
          to: '/login',
        })
      })
  }, [completeSsoLogin, jwt, navigate])

  return (
    <main className="flex min-h-dvh items-center justify-center text-on-background">
      <p className="text-body">正在完成企业 SSO 登录…</p>
    </main>
  )
}
