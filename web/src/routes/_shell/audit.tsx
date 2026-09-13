import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuditRoute } from '@/features/conversations'
import { useTaskOptions } from '@/features/tasks'
import { ensureSessionUser } from '@/shared/auth'

// 全部对话是治理者的页：没登录或没有 users:manage 都回首页，不给第二种入口。
export const Route = createFileRoute('/_shell/audit')({
  beforeLoad: async () => {
    const user = await ensureSessionUser()
    if (!user?.permissions.includes('users:manage')) {
      throw redirect({ to: '/' })
    }
  },
  component: AuditIndexRoute,
})

/** 需求单候选在路由层取：conversations 与 tasks 两个 feature 不直接互引。 */
function AuditIndexRoute() {
  const tasks = useTaskOptions(true)
  return <AuditRoute tasks={tasks.data ?? []} />
}
