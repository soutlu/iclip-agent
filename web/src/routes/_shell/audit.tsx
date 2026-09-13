import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuditRoute } from '@/features/conversations'
import { useTaskOptions } from '@/features/tasks'
import { ensureSessionUser, useUser } from '@/shared/auth'

// 全部对话是治理者的页：接口同时要 users:manage 与 agent:read（合同 §6），没登录或权限不够都回首页。
export const Route = createFileRoute('/_shell/audit')({
  beforeLoad: async () => {
    const user = await ensureSessionUser()
    const permissions = user?.permissions ?? []
    if (!permissions.includes('users:manage') || !permissions.includes('agent:read')) {
      throw redirect({ to: '/' })
    }
  },
  component: AuditIndexRoute,
})

/** 需求单候选在路由层取：conversations 与 tasks 两个 feature 不直接互引；没有 tasks:read 就不问。 */
function AuditIndexRoute() {
  const { data: user } = useUser()
  const canReadTasks = Boolean(user?.permissions.includes('tasks:read'))
  const tasks = useTaskOptions(canReadTasks)
  return (
    <AuditRoute
      onTasksRetry={() => void tasks.refetch()}
      taskFilterEnabled={canReadTasks}
      tasks={tasks.data ?? []}
      tasksError={tasks.error?.message}
      tasksPending={canReadTasks && tasks.isPending}
    />
  )
}
