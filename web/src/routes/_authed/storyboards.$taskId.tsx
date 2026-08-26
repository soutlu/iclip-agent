import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { SDHS2496W_DEMO_MODE, StoryboardRoute } from '@/features/storyboards'
import { canEditProducerProjects, requireSession } from '@/shared/auth'

export const Route = createFileRoute('/_authed/storyboards/$taskId')({
  beforeLoad: async ({ location }) => {
    const user = await requireSession(location.href)

    if (!canEditProducerProjects(user)) {
      throw redirect({ to: '/' })
    }
  },
  component: StoryboardsPage,
  validateSearch: z.object({
    /** 看这张单的哪一次尝试（对话 id）；缺省看最新的那次。 */
    attempt: z.string().optional(),
    demo: z.literal(SDHS2496W_DEMO_MODE).optional(),
  }),
})

/**
 * 渲染一张需求单的 Storyboard 工作台路由。
 *
 * @returns Storyboards feature 页面。
 */
function StoryboardsPage() {
  const { taskId } = Route.useParams()
  const { attempt, demo } = Route.useSearch()

  return <StoryboardRoute attemptConversationId={attempt} demoMode={demo} taskId={taskId} />
}
