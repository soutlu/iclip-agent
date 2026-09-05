import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { type ComposerPart, readyAttachment } from '@/shared/ui/composer'
import { mediaDisplayName } from '@/shared/ui/media-preview'
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

export type ConversationPage = z.output<typeof zConversationPageOut>

/** 侧栏拓扑里的一个合集：元信息、总条数，加第一页对话。 */
export type SidebarCollection = z.output<typeof zSidebarOut>['collections'][number]

/** 侧栏拓扑：任务区第一页加每个合集（各带自己的第一页）。 */
export type SidebarTopology = z.output<typeof zSidebarOut>

const conversationsPageSchema = zConversationsPageOut.transform((payload) => payload.items)
const conversationEnvelopeSchema = zConversationEnvelope.transform(
  (payload) => payload.conversation,
)

const SEARCH_LIMIT = 50

/** running 为正在运行，done 为至少结束过一轮；未发送过消息的对话仅属于 all。 */
export type ConversationListState = 'all' | 'running' | 'done'

export const conversationsQueryKeys = {
  all: ['conversations'] as const,
  more: (bucket: string, cursor: string, state: ConversationListState) =>
    ['conversations', 'more', bucket, cursor, state] as const,
  search: (keyword: string) => ['conversations', 'search', keyword] as const,
  /** 未传 state 时作为所有筛选的缓存键前缀。 */
  sidebar: (state?: ConversationListState): readonly string[] =>
    state === undefined ? ['conversations', 'sidebar'] : ['conversations', 'sidebar', state],
}

/** 服务端按标题搜索当前用户的全部对话，按最近活动排序。 */
export const searchConversations = async (keyword: string): Promise<Conversation[]> =>
  apiFetch(
    `/conversations/search?q=${encodeURIComponent(keyword)}&limit=${SEARCH_LIMIT}`,
    conversationsPageSchema,
    { cache: 'no-store', fallbackErrorMessage: '搜索对话失败' },
  )

/** 分组、计数和首页数据来自同一服务端拓扑，避免不同查询时间点造成不一致。 */
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

/** 额外分页仅由用户触发；拓扑失效时丢弃这些页，避免自动逐页重拉。bucket 筛选需与拓扑一致。 */
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

/** 客户端 promptId 用于服务端幂等去重；回执丢失时须复用同一 ID 重试。 */
export const useStartConversation = (onCreated: (conversationId: string) => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ agentId, parts }: { agentId: string; parts: readonly ComposerPart[] }) => {
      const conversation = await apiFetch('/conversations', conversationEnvelopeSchema, {
        body: { agentId },
        fallbackErrorMessage: '新建对话失败',
        method: 'POST',
      })
      // 先进入会话页再提交消息，订阅与基线加载无需等待提交回执。
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

export const mintPromptId = (): string => crypto.randomUUID()

/** 保持文字与媒体相对顺序；空文字、未就绪附件和文件附件不进入消息。 */
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

/** 取消排队或运行中的消息；已结束状态视为成功，容忍与自然结束的竞态。 */
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

/** 将排队消息追加到当前轮；消息已离开队列时视为成功，容忍自动出队的竞态。 */
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

/** 相同审批决定可重复提交；409 决定冲突和 404 交互失效均由调用方展示。 */
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

/** 恢复已发消息时复用媒体地址并标记为就绪，保持 part 顺序。 */
export const composerParts = (content: readonly PromptContentPart[]): ComposerPart[] =>
  content.map((part) =>
    part.type === 'text'
      ? { kind: 'text', text: part.text }
      : {
          kind: 'media',
          media: readyAttachment({
            kind: part.type,
            name: mediaDisplayName({ kind: part.type, name: fileNameOfUrl(part.source.url) }),
            url: part.source.url,
          }),
        },
  )

/** 服务端替换末轮并重新运行；新轮经推送更新，409 与 404 原样交给调用方。 */
export const regeneratePrompt = async (
  conversationId: string,
  turnId: string,
  edit?: { promptId: string; content: readonly PromptContentPart[] },
): Promise<void> => {
  await apiFetch(`/conversations/${conversationId}/turns/${turnId}:regenerate`, zPrompt, {
    ...(edit === undefined ? {} : { body: { content: edit.content, prompt_id: edit.promptId } }),
    fallbackErrorMessage: '重新生成失败',
    method: 'POST',
  })
}

/** 只提取文字 part，忽略附件及无效条目。 */
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

/** 队列预览只提取 URL 来源的图片与视频。 */
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
  /** undefined 保持原归属，null 解除归属。 */
  collectionId?: string | null
  conversationId: string
  taskId?: string | null
}

/** 两处归属分别调用端点；保存后由调用方刷新拓扑。 */
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

/** 删除返回 204，无响应正文。 */
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
