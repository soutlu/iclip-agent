import { createFileRoute, redirect } from '@tanstack/react-router'
import { ConversationRoute } from '@/features/conversations'
import { ensureSessionUser } from '@/shared/auth'

// 会话页只对登录用户开放：对话是私有的，未登录（含会话过期后 401 触发的路由重算）回首页。
export const Route = createFileRoute('/_shell/c/$conversationId')({
  beforeLoad: async () => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
  },
  component: ConversationIndexRoute,
})

/**
 * 装配会话页。
 *
 * @returns 会话页内容。
 */
function ConversationIndexRoute() {
  const { conversationId } = Route.useParams()
  return <ConversationRoute conversationId={conversationId} />
}
