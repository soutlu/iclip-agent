import { createFileRoute } from '@tanstack/react-router'
import { TasksRoute } from '@/features/tasks'
import { useUser } from '@/shared/auth'
import { useLoginPrompt } from '../-login-prompt'

export const Route = createFileRoute('/_shell/tasks')({
  component: TasksIndexRoute,
})

/**
 * 装配任务页：未登录时把「新建项目」接到登录弹窗上，列表本身未登录就显示空态。
 *
 * @returns 任务页内容。
 */
function TasksIndexRoute() {
  const { data: user } = useUser()
  const requireLogin = useLoginPrompt()

  return <TasksRoute onRequireLogin={user ? undefined : requireLogin} />
}
