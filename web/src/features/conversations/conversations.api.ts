import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zConversationEnvelope,
  zConversationsPageOut,
  zSidebarOut,
} from '@/shared/api/generated/zod.gen'

export type Conversation = z.output<typeof zConversationsPageOut>['items'][number]

const conversationsPageSchema = zConversationsPageOut.transform((payload) => payload.items)
const conversationEnvelopeSchema = zConversationEnvelope.transform(
  (payload) => payload.conversation,
)

// 一屏放得下的命中数；再多就该换更准的词，而不是往下翻
const SEARCH_LIMIT = 50

export const conversationsQueryKeys = {
  all: ['conversations'] as const,
  search: (keyword: string) => ['conversations', 'search', keyword] as const,
  sidebar: () => ['conversations', 'sidebar'] as const,
}

/** 按标题搜自己的对话，最近活动的排前面。筛选在服务端做，搜得到全部历史而不只是最近几十段。 */
export const searchConversations = async (keyword: string): Promise<Conversation[]> =>
  apiFetch(
    `/conversations/search?q=${encodeURIComponent(keyword)}&limit=${SEARCH_LIMIT}`,
    conversationsPageSchema,
    { cache: 'no-store', fallbackErrorMessage: '搜索对话失败' },
  )

/**
 * 侧栏拓扑：我的合集（各带条数与最近几段对话）加上没归类的那些。
 *
 * 分组、条数与每组取几段全在服务端算好，这里不再自己拼——两次查询拼出来的两半会来自
 * 库的两个时刻。
 *
 * @param enabled - 未登录时不发请求（侧栏那一区会退成登录入口）。
 * @returns TanStack query。
 */
export const useSidebarTopology = (enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: () =>
      apiFetch('/conversations', zSidebarOut, {
        cache: 'no-store',
        fallbackErrorMessage: '读取对话列表失败',
      }),
    queryKey: conversationsQueryKeys.sidebar(),
  })

type Membership = {
  /** 没给就是不动这一处归属；给 null 是摘掉 */
  collectionId?: string | null
  conversationId: string
  taskId?: string | null
}

/**
 * 改一段对话的两处归属。两处各是一个端点，只发真的变了的那几个。
 *
 * @param onSaved - 落库之后调用，由调用方刷掉侧栏那份拓扑。
 * @returns TanStack mutation。
 */
export const useSetConversationMembership = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ collectionId, conversationId, taskId }: Membership) => {
      if (collectionId !== undefined) {
        await apiFetch(`/conversations/${conversationId}/collection`, conversationEnvelopeSchema, {
          body: { collectionId },
          fallbackErrorMessage: '移动对话失败',
          method: 'PUT',
        })
      }
      if (taskId !== undefined) {
        await apiFetch(`/conversations/${conversationId}/task`, conversationEnvelopeSchema, {
          body: { taskId },
          fallbackErrorMessage: '关联需求单失败',
          method: 'PUT',
        })
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
      onSaved()
    },
  })
}
