import { redirect } from '@tanstack/react-router'
import type { ProducerAuthUser } from './producer-auth.types'
import { ensureSessionUser } from './session'

/**
 * 路由级登录守卫，在路由 beforeLoad 中 await 调用。
 *
 * 会话以 GET /users/me 为唯一事实源（HttpOnly cookie 客户端读不到，只能异步判定）。
 *
 * @param currentHref - 当前路由地址，登录后回跳用。
 * @returns 当前登录用户。
 * @throws 未登录时 redirect 到 /login 并携带回跳地址。
 */
export const requireSession = async (currentHref: string): Promise<ProducerAuthUser> => {
  const user = await ensureSessionUser()

  if (!user) {
    throw redirect({ search: { redirect: currentHref }, to: '/login' })
  }

  return user
}
