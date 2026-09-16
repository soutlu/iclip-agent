/** 治理者页的进门守卫：接口同时要 users:manage 与 agent:read（合同 §6、§12），没登录或权限不够都回首页。 */

import { redirect } from '@tanstack/react-router'
import { ensureSessionUser } from '@/shared/auth'

export async function requireGovernor(): Promise<void> {
  const user = await ensureSessionUser()
  const permissions = user?.permissions ?? []
  if (!permissions.includes('users:manage') || !permissions.includes('agent:read')) {
    throw redirect({ to: '/' })
  }
}
