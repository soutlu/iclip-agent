/**
 * 记住是从全部对话的哪一行点进去的，供对话页上的返回按钮退回同一屏；只在本标签页有效。
 * 按对话 id 核对：从审计页、侧栏或外部链接进来的对话没有这条记录，返回按钮就回默认视图。
 */

import { z } from 'zod'
import { conversationsSearchSchema, type ConversationsSearch } from './-conversations-search'

const KEY = 'cue.conversations.return'

const returnMarkSchema = z.object({
  conversationId: z.string().min(1),
  search: conversationsSearchSchema,
})

/** 存储内容与地址栏同属外部输入，读出来一律过一遍 schema，坏值当没记过。 */
export const conversationsReturnSearch = (conversationId: string): ConversationsSearch => {
  try {
    const stored = window.sessionStorage.getItem(KEY)
    if (stored === null) return {}
    const mark = returnMarkSchema.safeParse(JSON.parse(stored))
    if (!mark.success || mark.data.conversationId !== conversationId) return {}
    return mark.data.search
  } catch {
    return {}
  }
}

export const rememberReturn = (conversationId: string, search: ConversationsSearch): void => {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ conversationId, search }))
  } catch {
    // 存储不可用时返回按钮退回默认视图，不影响浏览器后退。
  }
}
