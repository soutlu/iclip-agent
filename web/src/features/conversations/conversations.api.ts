import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zConversationsPageOut } from '@/shared/api/generated/zod.gen'

export type Conversation = z.output<typeof zConversationsPageOut>['items'][number]

const conversationsPageSchema = zConversationsPageOut.transform((payload) => payload.items)

// 一屏放得下的命中数；再多就该换更准的词，而不是往下翻
const SEARCH_LIMIT = 50

export const conversationsQueryKeys = {
  all: ['conversations'] as const,
  search: (keyword: string) => ['conversations', 'search', keyword] as const,
}

/** 按标题搜自己的对话，最近活动的排前面。筛选在服务端做，搜得到全部历史而不只是最近几十段。 */
export const searchConversations = async (keyword: string): Promise<Conversation[]> =>
  apiFetch(
    `/conversations?q=${encodeURIComponent(keyword)}&limit=${SEARCH_LIMIT}`,
    conversationsPageSchema,
    { cache: 'no-store', fallbackErrorMessage: '搜索对话失败' },
  )
