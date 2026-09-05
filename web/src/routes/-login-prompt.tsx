import { createContext, use } from 'react'

// 登录弹窗由应用壳持有，feature 经回调请求打开，避免跨 feature 依赖。
const LoginPromptContext = createContext<(() => void) | null>(null)

export const LoginPromptProvider = LoginPromptContext

/** 必须在应用壳内调用，否则抛错。 */
export function useLoginPrompt() {
  const requireLogin = use(LoginPromptContext)

  if (!requireLogin) {
    throw new Error('useLoginPrompt 必须在应用壳内使用')
  }

  return requireLogin
}
