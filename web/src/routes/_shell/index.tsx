import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useStartConversation } from '@/features/conversations'
import { HomeRoute } from '@/features/home'
import { useUser } from '@/shared/auth'
import { toast } from '@/shared/ui/toast'
import { useLoginPrompt } from '../-login-prompt'

export const Route = createFileRoute('/_shell/')({
  component: HomeIndexRoute,
})

/**
 * 装配首页：发送就是「新建一段对话 + 把这条消息发进去」，然后跳到会话页。
 *
 * 首页与会话页是两个 feature，互相不能引用，所以这条线在路由层接起来。未登录一律先弹登录框。
 *
 * @returns 首页内容。
 */
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
