import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import type { ComposerPart } from '@/shared/ui/composer'
import {
  zApproveConversationsConversationIdInteractionsInteractionIdPostResponse,
  zConversationEnvelope,
  zConversationPageOut,
  zConversationsPageOut,
  zImageContent,
  zPrompt,
  zSidebarOut,
  zTextContent,
  zVideoContent,
} from '@/shared/api/generated/zod.gen'

export type Conversation = z.output<typeof zConversationsPageOut>['items'][number]

/** 一页对话：这一页的条目加下一页的游标。 */
export type ConversationPage = z.output<typeof zConversationPageOut>

/** 侧栏拓扑里的一个合集：元信息、总条数，加第一页对话。 */
export type SidebarCollection = z.output<typeof zSidebarOut>['collections'][number]

const conversationsPageSchema = zConversationsPageOut.transform((payload) => payload.items)
const conversationEnvelopeSchema = zConversationEnvelope.transform(
  (payload) => payload.conversation,
)

// 一屏放得下的命中数；再多就该换更准的词，而不是往下翻
const SEARCH_LIMIT = 50

/** 列表要哪一段：全部、有轮次在跑的、跑完过至少一轮的。从没发过消息的只在 `all` 里。 */
export type ConversationListState = 'all' | 'running' | 'done'

export const conversationsQueryKeys = {
  all: ['conversations'] as const,
  more: (bucket: string, cursor: string, state: ConversationListState) =>
    ['conversations', 'more', bucket, cursor, state] as const,
  search: (keyword: string) => ['conversations', 'search', keyword] as const,
  /** 不给 `state` 就是三段筛选的公共前缀：重拉列表的人不必知道当前筛的是哪一段。 */
  sidebar: (state?: ConversationListState): readonly string[] =>
    state === undefined ? ['conversations', 'sidebar'] : ['conversations', 'sidebar', state],
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
 * @param state - 要哪一段；两个数字（`ungroupedCount` 与各合集的 `conversationCount`）按同一筛选算。
 * @returns TanStack query。
 */
export const useSidebarTopology = (enabled: boolean, state: ConversationListState) =>
  useQuery({
    enabled,
    queryFn: () =>
      apiFetch(`/conversations?state=${state}`, zSidebarOut, {
        cache: 'no-store',
        fallbackErrorMessage: '读取对话列表失败',
      }),
    queryKey: conversationsQueryKeys.sidebar(state),
  })

/**
 * 「展开显示」再取的那些页。首屏那一页来自拓扑，这里只管它之后的。
 *
 * 不把拓扑那一页塞进来当第一页：TanStack 的分页查询在缓存失效时会把已加载的每一页挨个
 * 重新请求，展开三页就是三个请求。这里 `enabled: false`，只有点「展开显示」才动；侧栏
 * 一失效，调用方把这些页整个丢掉，列表收回第一页。
 *
 * @param bucket - 哪一段列表：不给 collectionId 就是「任务」区；`state` 与拓扑那一页同一档筛选。
 * @param cursor - 拓扑给的 `nextCursor`；为空表示本来就没有更多。
 * @returns TanStack 分页查询。
 */
export const useMoreConversations = (
  { collectionId, state }: { collectionId?: string | undefined; state: ConversationListState },
  cursor: string | null,
) => {
  return useInfiniteQuery({
    queryKey: conversationsQueryKeys.more(collectionId ?? 'ungrouped', cursor ?? '', state),
    queryFn: ({ pageParam }) =>
      apiFetch(
        `${
          collectionId ? `/conversations/by-collection/${collectionId}` : '/conversations/ungrouped'
        }?cursor=${encodeURIComponent(pageParam)}&state=${state}`,
        zConversationPageOut,
        { cache: 'no-store', fallbackErrorMessage: '加载更多对话失败' },
      ),
    initialPageParam: cursor ?? '',
    getNextPageParam: (last: z.output<typeof zConversationPageOut>) => last.nextCursor,
    enabled: false,
  })
}

/**
 * 新建一段对话，再把第一条消息发进去。
 *
 * `promptId` 由客户端铸，重发同一个不会多起一次运行——所以「发出去了但没收到回执」时，
 * 界面重试是安全的。
 *
 * @param onCreated - 拿到对话 id 之后调用（路由层用它跳过去）。
 * @returns TanStack mutation。
 */
export const useStartConversation = (onCreated: (conversationId: string) => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ agentId, parts }: { agentId: string; parts: readonly ComposerPart[] }) => {
      const conversation = await apiFetch('/conversations', conversationEnvelopeSchema, {
        body: { agentId },
        fallbackErrorMessage: '新建对话失败',
        method: 'POST',
      })
      // 先跳过去再发：会话页那一侧订阅与拉基线都不依赖这条消息的回执，早跳一步用户就早看到
      // 自己那条话。
      onCreated(conversation.id)
      await submitPrompt(conversation.id, {
        content: partsContent(parts),
        promptId: mintPromptId(),
      })
      return conversation
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
    },
  })
}

/** 铸一个 prompt id。界面拿它挂乐观气泡，服务端拿它去重。 */
export const mintPromptId = (): string => crypto.randomUUID()

/**
 * 输入框里的段 → 消息的 part 列表：文字与图按原来的先后交替，「这张图」指的还是紧挨着的那张。
 * 空文字段与没拿到地址的附件、文件类附件都进不了消息。
 */
export const partsContent = (parts: readonly ComposerPart[]): PromptContentPart[] =>
  parts.flatMap((part): PromptContentPart[] => {
    if (part.kind === 'text') return part.text === '' ? [] : [{ text: part.text, type: 'text' }]
    const { kind, url } = part.media
    return url !== undefined && (kind === 'image' || kind === 'video')
      ? [{ source: { kind: 'url', url }, type: kind }]
      : []
  })

/** 往一段对话里发一条消息。同一个 `promptId` 重发不会多起一次运行。 */
export const submitPrompt = async (
  conversationId: string,
  { content, promptId }: { promptId: string; content: readonly PromptContentPart[] },
): Promise<void> => {
  await apiFetch(`/conversations/${conversationId}/prompts`, zPrompt, {
    body: { content, prompt_id: promptId },
    fallbackErrorMessage: '发送失败',
    method: 'POST',
  })
}

/**
 * 停掉一条消息：排着的直接撤，在跑的发第一方取消让它自己收尾。
 *
 * 「这条早就结束了」不算失败：停止是用户按一次的动作，正好按在收尾那一刻不该弹错误。
 */
export const abortPrompt = async (conversationId: string, promptId: string): Promise<void> => {
  try {
    await apiFetch(`/conversations/${conversationId}/prompts/${promptId}:abort`, z.unknown(), {
      fallbackErrorMessage: '停止失败',
      method: 'POST',
    })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) return
    throw error
  }
}

/**
 * 把一条排着的消息插进正在跑的那一轮，不必等它跑完。
 *
 * 「已经不在队列里了」同样不算失败——那说明它自己排到了，用户要的事情已经发生。
 */
export const steerPrompt = async (conversationId: string, promptId: string): Promise<void> => {
  try {
    await apiFetch(`/conversations/${conversationId}/prompts:steer`, z.unknown(), {
      body: { prompt_ids: [promptId] },
      fallbackErrorMessage: '追加失败',
      method: 'POST',
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return
    throw error
  }
}

/**
 * 对一张审批卡点同意或拒绝。
 *
 * 决定记下就是 204，续跑由服务端自己起。重复点同一个决定照样 204；改主意是 409，卡已经不在等
 * 回应的那几张里是 404——两个都原样抛给调用方，让它就地说清楚。
 */
export const respondInteraction = async (
  conversationId: string,
  interactionId: string,
  approved: boolean,
): Promise<void> => {
  await apiFetch(
    `/conversations/${conversationId}/interactions/${interactionId}`,
    zApproveConversationsConversationIdInteractionsInteractionIdPostResponse,
    { body: { approved }, fallbackErrorMessage: '提交决定失败', method: 'POST' },
  )
}

/**
 * 重新生成一轮：服务端把末轮从历史里抹掉，按那条消息的原内容重跑一次。
 *
 * 答复是新铸的 prompt 记录，但这里不留它——新的一轮走推送自然回流。409（对话在忙、动的
 * 不是末轮）与 404（消息没了）都原样抛给调用方，让用户看到原因。
 */
export const regeneratePrompt = async (conversationId: string, turnId: string): Promise<void> => {
  await apiFetch(`/conversations/${conversationId}/turns/${turnId}:regenerate`, zPrompt, {
    fallbackErrorMessage: '重新生成失败',
    method: 'POST',
  })
}

/** 一条 prompt 里用户打的字。附件那些形态这里不取，但也不能让它们把整条解析带崩。 */
export const promptText = (content: unknown): string => {
  const parsed = z.array(z.unknown()).safeParse(content)
  if (!parsed.success) return ''
  return parsed.data
    .flatMap((part) => {
      const text = zTextContent.safeParse(part)
      return text.success ? [text.data.text] : []
    })
    .join('')
}

/** 一条 prompt 里附着的图片与视频（队列行缩略图用）；只有 url 来源的给得出地址。 */
export const promptMedia = (content: unknown): { kind: 'image' | 'video'; url: string }[] => {
  const parsed = z.array(z.unknown()).safeParse(content)
  if (!parsed.success) return []
  const out: { kind: 'image' | 'video'; url: string }[] = []
  for (const part of parsed.data) {
    const image = zImageContent.safeParse(part)
    const video = zVideoContent.safeParse(part)
    const media = image.success ? image.data : video.success ? video.data : undefined
    if (media === undefined || media.source.kind !== 'url' || !media.source.url) continue
    out.push({ kind: image.success ? 'image' : 'video', url: media.source.url })
  }
  return out
}

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

/** 重命名对话。 */
export const useRenameConversation = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
      apiFetch(`/conversations/${conversationId}`, conversationEnvelopeSchema, {
        body: { title },
        fallbackErrorMessage: '重命名失败',
        method: 'PATCH',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
      onSaved()
    },
  })
}

/** 删除对话，返回 204 没有正文可校验。 */
export const useDeleteConversation = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (conversationId: string) =>
      apiFetch(`/conversations/${conversationId}`, z.unknown(), {
        fallbackErrorMessage: '删除失败',
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
      onSaved()
    },
  })
}
