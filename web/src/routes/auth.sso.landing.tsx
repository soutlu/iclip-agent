import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SsoLandingPage } from '@/features/auth'

// SSO 服务端按 sso-sdk 惯例带 ?jwt_token= 回跳；兼容 ?jwt= 写法。
const SsoLandingSearchSchema = z.object({
  jwt: z.string().optional().catch(undefined),
  jwt_token: z.string().optional().catch(undefined),
})

// 公开路由：SSO 登录完成后的回跳落地页（后端 ICLIP_SSO_REDIRECT_URL 指向这里）。
export const Route = createFileRoute('/auth/sso/landing')({
  component: SsoLandingRoute,
  validateSearch: SsoLandingSearchSchema,
})

/**
 * 渲染 SSO 落地路由。
 *
 * @returns SSO 落地页。
 */
function SsoLandingRoute() {
  const search = Route.useSearch()

  return <SsoLandingPage jwt={search.jwt_token ?? search.jwt} />
}
