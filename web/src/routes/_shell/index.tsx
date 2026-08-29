import { createFileRoute } from '@tanstack/react-router'
import { HomeRoute } from '@/features/home'
import { useUser } from '@/shared/auth'
import { useLoginPrompt } from '../-login-prompt'

export const Route = createFileRoute('/_shell/')({
  component: HomeIndexRoute,
})

/**
 * 装配首页：未登录时把「发送」接到登录弹窗上。
 *
 * @returns 首页内容。
 */
function HomeIndexRoute() {
  const { data: user } = useUser()
  const requireLogin = useLoginPrompt()

  // 发送还没接后端；登录后先留空，未登录一律先弹登录框
  return <HomeRoute onSend={user ? undefined : requireLogin} />
}
