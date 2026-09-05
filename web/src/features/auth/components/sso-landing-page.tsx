import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { ApiError } from '@/shared/api/client'
import { consumeSsoNextPath, sanitizeCueAuthNextPath, useCompleteSsoLogin } from '@/shared/auth'

type SsoLandingPageProps = {
  jwt?: string | undefined
}

const ssoErrorCodeFromError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) {
    return 'invalid'
  }

  if (error instanceof ApiError && error.status === 403) {
    return 'forbidden'
  }

  return 'unavailable'
}

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

    // 失败回首页并传递错误码，由应用壳显示登录弹窗。
    if (!jwt) {
      void navigate({ replace: true, search: { ssoError: 'missing' }, to: '/' })
      return
    }

    completeSsoLogin(jwt)
      .then(() => {
        void navigate({ replace: true, to: sanitizeCueAuthNextPath(consumeSsoNextPath()) })
      })
      .catch((error: unknown) => {
        void navigate({
          replace: true,
          search: { ssoError: ssoErrorCodeFromError(error) },
          to: '/',
        })
      })
  }, [completeSsoLogin, jwt, navigate])

  return (
    <main className="flex min-h-dvh items-center justify-center text-on-background">
      <p className="text-body">正在完成企业 SSO 登录…</p>
    </main>
  )
}
