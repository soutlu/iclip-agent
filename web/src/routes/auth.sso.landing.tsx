import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SsoLandingPage } from '@/features/auth'

// SSO 回跳使用 jwt_token，并兼容 jwt 参数。
const SsoLandingSearchSchema = z.object({
  jwt: z.string().optional().catch(undefined),
  jwt_token: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/auth/sso/landing')({
  component: SsoLandingRoute,
  validateSearch: SsoLandingSearchSchema,
})

function SsoLandingRoute() {
  const search = Route.useSearch()

  return <SsoLandingPage jwt={search.jwt_token ?? search.jwt} />
}
