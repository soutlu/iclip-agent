import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AnalyticsRoute } from '@/features/analytics'
import { canViewProducerAnalytics, requireSession } from '@/shared/auth'

export const Route = createFileRoute('/_authed/analytics')({
  beforeLoad: async ({ location }) => {
    const user = await requireSession(location.href)

    // UI 门控：未持有后端 RBAC analytics:read 权限的用户回首页；执法在后端接口。
    if (!canViewProducerAnalytics(user)) {
      throw redirect({ to: '/' })
    }
  },
  component: AnalyticsPage,
})

/**
 * 渲染受限的 Producer 生成统计路由。
 *
 * @returns 生成统计页。
 */
function AnalyticsPage() {
  useEffect(() => {
    document.title = '生成统计 | Producer'

    return () => {
      document.title = 'Producer'
    }
  }, [])

  return <AnalyticsRoute />
}
