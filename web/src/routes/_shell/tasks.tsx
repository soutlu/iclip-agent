import { createFileRoute, redirect } from '@tanstack/react-router'
import { TasksRoute } from '@/features/tasks'
import { ensureSessionUser } from '@/shared/auth'

// 需求单路由要求登录，会话失效后返回首页。
export const Route = createFileRoute('/_shell/tasks')({
  beforeLoad: async () => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
  },
  component: TasksIndexRoute,
})

function TasksIndexRoute() {
  return <TasksRoute />
}
