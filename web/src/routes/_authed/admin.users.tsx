import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AdminUsersRoute } from '@/features/admin-users'
import { canManageProducerUsers, requireSession } from '@/shared/auth'

export const Route = createFileRoute('/_authed/admin/users')({
  beforeLoad: async ({ location }) => {
    const user = await requireSession(location.href)

    // UI 门控：未持有后端 RBAC users:manage 权限的用户回首页；执法在后端接口。
    if (!canManageProducerUsers(user)) {
      throw redirect({ to: '/' })
    }
  },
  component: AdminUsersPage,
})

/**
 * 渲染受限的用户管理路由。
 *
 * @returns 用户管理页。
 */
function AdminUsersPage() {
  useEffect(() => {
    document.title = '用户管理 | Producer'

    return () => {
      document.title = 'Producer'
    }
  }, [])

  return <AdminUsersRoute />
}
