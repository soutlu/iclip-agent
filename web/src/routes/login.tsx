import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { LoginPage } from '@/features/auth'
import { ensureSessionUser, sanitizeProducerAuthNextPath } from '@/shared/auth'

const LoginSearchSchema = z.object({
  redirect: z.string().optional().catch(undefined),
  ssoError: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/login')({
  beforeLoad: async ({ search }) => {
    // 已登录访问登录页：直接回跳目标页。
    if (await ensureSessionUser()) {
      throw redirect({ to: sanitizeProducerAuthNextPath(search.redirect) })
    }
  },
  component: LoginRoute,
  validateSearch: LoginSearchSchema,
})

/**
 * 渲染登录路由。
 *
 * @returns 登录页。
 */
function LoginRoute() {
  const { redirect: redirectTo, ssoError } = Route.useSearch()

  useEffect(() => {
    document.title = '登录 | Producer'

    return () => {
      document.title = 'Producer'
    }
  }, [])

  return <LoginPage nextPath={sanitizeProducerAuthNextPath(redirectTo)} ssoErrorCode={ssoError} />
}
