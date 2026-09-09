import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useStartConversation } from '@/features/conversations'
import { HomeRoute } from '@/features/home'
import { useUser } from '@/shared/auth'
import { toast } from '@/shared/ui/toast'
import { useLoginPrompt } from '../-login-prompt'

export const Route = createFileRoute('/_shell/')({
  component: HomeIndexRoute,
})

/** 首页与会话属于不同 feature，由路由层连接新建、发送和跳转流程。 */
function HomeIndexRoute() {
  const { data: user } = useUser()
  const requireLogin = useLoginPrompt()
  const navigate = useNavigate()

  const start = useStartConversation((conversationId) => {
    void navigate({ params: { conversationId }, to: '/c/$conversationId' })
  })

  return (
    <HomeRoute
      onSend={
        user
          ? (input) => start.mutate(input, { onError: (error) => toast.error(error.message) })
          : () => requireLogin()
      }
      sending={start.isPending}
    />
  )
}
