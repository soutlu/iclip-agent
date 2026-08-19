import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { StoryboardDebugRoute } from '@/features/storyboards'
import { canEditProducerProjects, requireSession } from '@/shared/auth'

export const Route = createFileRoute('/_authed/storyboard-debug')({
  beforeLoad: async ({ location }) => {
    const user = await requireSession(location.href)

    if (!canEditProducerProjects(user)) {
      throw redirect({ to: '/' })
    }
  },
  component: StoryboardDebugPage,
  validateSearch: z.object({
    sessionId: z.string().trim().min(1).optional(),
    taskId: z.string().optional(),
  }),
})

/**
 * 渲染 Storyboard Agent 独立调试路由（入口在任务确认列表的调试按钮）。
 *
 * @returns Storyboard 调试 feature 页面。
 */
function StoryboardDebugPage() {
  const { sessionId, taskId } = Route.useSearch()

  return <StoryboardDebugRoute sessionId={sessionId} taskId={taskId} />
}
