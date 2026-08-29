import { createContext, use } from 'react'

// 请求登录的信号：应用壳持有弹窗状态，页面只管在需要登录的动作上调 requireLogin()。
// 放 routes 层是因为壳（侧栏、弹窗）本来就归这层装配，feature 之间不必为此互相认领。
const LoginPromptContext = createContext<(() => void) | null>(null)

export const LoginPromptProvider = LoginPromptContext

/**
 * 取「打开登录弹窗」的回调。
 *
 * @returns 触发登录弹窗的函数。
 * @throws 不在应用壳内使用时抛错，避免静默拿到一个不弹窗的空函数。
 */
export function useLoginPrompt() {
  const requireLogin = use(LoginPromptContext)

  if (!requireLogin) {
    throw new Error('useLoginPrompt 必须在应用壳内使用')
  }

  return requireLogin
}
