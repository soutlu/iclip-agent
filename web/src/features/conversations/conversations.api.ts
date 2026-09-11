import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { mintUuid } from '@/shared/lib/uuid'
import { type ComposerPart, readyAttachment } from '@/shared/ui/composer'
import { mediaDisplayName } from '@/shared/ui/media-preview'
import {
  zApproveConversationsConversationIdInteractionsInteractionIdPostResponse,
  zConversationAgentsOut,
  zConversationEnvelope,
  zConversationPageOut,
  zConversationsPageOut,
  zImageContent,
  zPrompt,
  zSidebarOut,
  zTextContent,
  zVideoContent,
  type zConversationIn,
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
  agents: ['conversation-agents'] as const,
  more: (bucket: string, cursor: string, state: ConversationListState) =>
    ['conversations', 'more', bucket, cursor, state] as const,
  search: (keyword: string) => ['conversations', 'search', keyword] as const,
  /** 未传 state 时作为所有筛选的缓存键前缀。 */
  sidebar: (state?: ConversationListState): readonly string[] =>
    state === undefined ? ['conversations', 'sidebar'] : ['conversations', 'sidebar', state],
}

/** 仅提供当前服务实际装配的顶层 Agent；顺序和默认项由服务端定义。 */
export const useConversationAgents = (enabled: boolean) =>
  useQuery({
    enabled,
    queryKey: conversationsQueryKeys.agents,
    queryFn: ({ signal }) =>
      apiFetch('/conversations/agents', zConversationAgentsOut, {
        signal,
        cache: 'no-store',
        fallbackErrorMessage: '读取 Agent 列表失败',
      }),
  })

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
    queryFn: ({ signal }) =>
      apiFetch(`/conversations?state=${state}`, zSidebarOut, {
        signal,
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
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `${
          collectionId ? `/conversations/by-collection/${collectionId}` : '/conversations/ungrouped'
        }?cursor=${encodeURIComponent(pageParam)}&state=${state}`,
        zConversationPageOut,
        { signal, cache: 'no-store', fallbackErrorMessage: '加载更多对话失败' },
      ),
    initialPageParam: cursor ?? '',
    getNextPageParam: (last: z.output<typeof zConversationPageOut>) => last.nextCursor,
    enabled: false,
  })
}

/** 创建对话；调用方可提供幂等编号、需求单和合集归属。 */
export const createConversation = async (
  body: z.input<typeof zConversationIn>,
): Promise<Conversation> =>
  apiFetch('/conversations', conversationEnvelopeSchema, {
    body,
    fallbackErrorMessage: '新建对话失败',
    method: 'POST',
  })

type StartConversationInput = {
  agentId: string
  collectionId: string | null
  parts: readonly ComposerPart[]
}

/** 相同提交重试复用两个幂等编号；首条消息成功后才离开首页。 */
export const useStartConversation = (
  ownerUserId: string | null,
  onCreated: (conversationId: string) => void,
) => {
  const queryClient = useQueryClient()
  const attemptRef = useRef<{
    fingerprint: string
    conversationId: string
    promptId: string
    conversation?: Conversation
  } | null>(null)
  return useMutation({
    mutationFn: async ({ agentId, collectionId, parts }: StartConversationInput) => {
      const content = partsContent(parts)
      const fingerprint = JSON.stringify({ ownerUserId, agentId, collectionId, content })
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, conversationId: mintUuid(), promptId: mintPromptId() }
      }
      const current = attemptRef.current
      try {
        const conversation =
          current.conversation ??
          (await createConversation({ agentId, collectionId, id: current.conversationId }))
        current.conversation = conversation
        await submitPrompt(conversation.id, { content, promptId: current.promptId })
        return conversation
      } catch (error) {
        // 已删除的对话 ID 不能再使用；仅在明确 404 后允许下一次主动提交另建对话。
        if (error instanceof ApiError && error.status === 404) attemptRef.current = null
        throw error
      }
    },
    onSuccess: (conversation) => {
      attemptRef.current = null
      onCreated(conversation.id)
    },
    onSettled: async () => {
      // 创建成功、首条消息失败时，侧栏也应能看到这段已存在的对话。
      queryClient.removeQueries({ queryKey: ['conversations', 'more'] })
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
    },
  })
}

export const mintPromptId = (): string => mintUuid()

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
export const useSetConversationMembership = (
  onSaved: () => void,
  onUpdated?: (conversation: Conversation) => void,
) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ collectionId, conversationId, taskId }: Membership) => {
      if (collectionId !== undefined) {
        const updated = await apiFetch(
          `/conversations/${conversationId}/collection`,
          conversationEnvelopeSchema,
          {
            body: { collectionId },
            fallbackErrorMessage: '移动对话失败',
            method: 'PUT',
          },
        )
        onUpdated?.(updated)
      }
      if (taskId !== undefined) {
        const updated = await apiFetch(
          `/conversations/${conversationId}/task`,
          conversationEnvelopeSchema,
          {
            body: { taskId },
            fallbackErrorMessage: '关联需求单失败',
            method: 'PUT',
          },
        )
        onUpdated?.(updated)
      }
    },
    onSettled: async () => {
      // 两个独立归属请求可能部分成功；失败也复核服务端实际状态。
      queryClient.removeQueries({ queryKey: ['conversations', 'more'] })
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
    },
    onSuccess: onSaved,
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
