/** 治理者页的进门守卫：没登录或看不了全部对话都回首页。 */

import { redirect } from '@tanstack/react-router'
import { canAuditAll, ensureSessionUser } from '@/shared/auth'

export async function requireGovernor(): Promise<void> {
  if (!canAuditAll(await ensureSessionUser())) {
    throw redirect({ to: '/' })
  }
}
