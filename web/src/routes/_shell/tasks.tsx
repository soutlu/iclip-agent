import { createFileRoute, redirect } from '@tanstack/react-router'
import { TasksRoute } from '@/features/tasks'
import { ensureSessionUser } from '@/shared/auth'

// 任务页只对登录用户开放：未登录（含退出登录、会话过期后 401 触发的路由重算）一律回首页，
// 首页游客态照常能看，只是动不了。
export const Route = createFileRoute('/_shell/tasks')({
  beforeLoad: async () => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
  },
  component: TasksIndexRoute,
})

/**
 * 装配任务页。守卫已挡下未登录，页面里不必再判登录态。
 *
 * @returns 任务页内容。
 */
function TasksIndexRoute() {
  return <TasksRoute />
}
