/** 记住最近一次全部对话的筛选，供对话页上的返回按钮退回同一屏；只在本标签页有效。 */

import { conversationsSearchSchema, type ConversationsSearch } from './-conversations-search'

const KEY = 'cue.conversations.search'

/** 存储内容与地址栏同属外部输入，读出来一律过一遍 schema，坏值当没筛过。 */
export const conversationsReturnSearch = (): ConversationsSearch => {
  try {
    const stored = window.sessionStorage.getItem(KEY)
    if (stored === null) return {}
    const parsed: unknown = JSON.parse(stored)
    const result = conversationsSearchSchema.safeParse(parsed)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}

export const rememberConversationsSearch = (search: ConversationsSearch): void => {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(search))
  } catch {
    // 存储不可用时返回按钮退回默认视图，不影响浏览器后退。
  }
}
