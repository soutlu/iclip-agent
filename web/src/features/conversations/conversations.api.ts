import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFilters,
} from '@tanstack/react-query'
import { useRef } from 'react'
import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { mintUuid } from '@/shared/lib/uuid'
import type { ComposerPart } from '@/shared/ui/composer'
import {
  zApproveConversationsConversationIdInteractionsInteractionIdPostResponse,
  zConversationAgentsOut,
  zConversationEnvelope,
  zConversationPageOut,
  zConversationsPageOut,
  zImageContent,
  zPrompt,
  zReadSidebarConversationsGetQuery,
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

/** 侧栏与全部对话页共用：``open`` / ``done`` 看属主标没标收尾，``running`` 是此刻在跑的那几段。
 *
 * 取合同查询参数的枚举，路由解析地址栏也用这一份，合同加档位时两边一起变。 */
export const conversationListStateSchema = zReadSidebarConversationsGetQuery.shape.state
  .unwrap()
  .unwrap()

export type ConversationListState = z.output<typeof conversationListStateSchema>

const SIDEBAR_KEY = ['conversations', 'sidebar'] as const
const MORE_KEY = ['conversations', 'more'] as const
const AUDIT_KEY = ['conversations', 'audit'] as const

export const conversationsQueryKeys = {
  all: ['conversations'] as const,
  agents: ['conversation-agents'] as const,
  /** 治理者的全部对话，按筛选条件分键；auditAll 作前缀整体失效。 */
  audit: (filters: object) => [...AUDIT_KEY, filters] as const,
  auditAll: AUDIT_KEY,
  /** 用户手动展开的额外分页；拓扑刷新时整体丢弃。 */
  moreAll: MORE_KEY,
  more: (bucket: string, cursor: string, state: ConversationListState) =>
    [...MORE_KEY, bucket, cursor, state] as const,
  search: (keyword: string) => ['conversations', 'search', keyword] as const,
  /** 未传 state 时作为所有筛选的缓存键前缀。 */
  sidebar: (state?: ConversationListState): readonly string[] =>
    state === undefined ? SIDEBAR_KEY : [...SIDEBAR_KEY, state],
  /**
   * 按 all 以外的状态筛选的侧栏拓扑或额外分页，对话状态一变它们的归属就可能不同。
   * state 是 sidebar(state) 与 more(…) 的末位，改这两种键的布局要连这里一起改。
   */
  filteredLists: (list: 'more' | 'sidebar'): QueryFilters => ({
    queryKey: list === 'sidebar' ? SIDEBAR_KEY : MORE_KEY,
    predicate: ({ queryKey }) => queryKey.at(-1) !== 'all',
  }),
}

/**
 * 对话列表的刷新配方：先丢掉用户手动展开的额外分页（拓扑一变它们的游标就不作数，留着会逐页重拉），
 * 再失效列表。
 *
 * 缺省失效全部会话列表（侧栏拓扑、搜索、需求单下的尝试、全部对话页），给改了对话的写操作用。
 * ``'sidebar'`` 只重拉侧栏拓扑，给全局帧与合集变动用：全部对话页另有节流窗口，不跟着每帧重拉。
 */
export const refreshConversationLists = (
  queryClient: QueryClient,
  scope: 'all' | 'sidebar' = 'all',
): Promise<void> => {
  queryClient.removeQueries({ queryKey: conversationsQueryKeys.moreAll })
  return queryClient.invalidateQueries({
    queryKey: scope === 'all' ? conversationsQueryKeys.all : conversationsQueryKeys.sidebar(),
  })
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
export const searchConversations = async (
  keyword: string,
  signal: AbortSignal,
): Promise<Conversation[]> =>
  apiFetch(
    `/conversations/search?q=${encodeURIComponent(keyword)}&limit=${SEARCH_LIMIT}`,
    conversationsPageSchema,
    { signal, cache: 'no-store', fallbackErrorMessage: '搜索对话失败' },
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

/** 需求单发起创作用的分镜 agent。取值是服务端 agents.yaml（不入库）里声明的键，那边改名这里跟着改。 */
export const STORYBOARD_AGENT_ID = 'storyboard'

/** 起一段对话的入参：正文给 composer 的 ``parts`` 或已拼好的 ``content``；归属与标题不给就不带。 */
export type StartConversationInput = {
  agentId: string
  collectionId?: string | null
  taskId?: string | null
  title?: string
} & ({ parts: readonly ComposerPart[] } | { content: readonly PromptContentPart[] })

/**
 * 建对话并发首条消息。对话 id 与消息 id 都由客户端铸，同一份输入重试复用两者：建对话的回执丢了
 * 重发不会多一段，首条消息重发不会多起一次运行。首条消息成功后才交给 ``onCreated``。
 */
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
    mutationFn: async (input: StartConversationInput) => {
      const { agentId, collectionId, taskId, title } = input
      const content = 'parts' in input ? partsContent(input.parts) : input.content
      // 不给与给 null 都是不挂，算同一份输入；请求体里不给的字段照旧不发。
      const fingerprint = JSON.stringify({
        agentId,
        collectionId: collectionId ?? null,
        content,
        ownerUserId,
        taskId: taskId ?? null,
        title: title ?? null,
      })
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, conversationId: mintUuid(), promptId: mintPromptId() }
      }
      const current = attemptRef.current
      try {
        const conversation =
          current.conversation ??
          (await createConversation({
            agentId,
            collectionId,
            id: current.conversationId,
            taskId,
            title,
          }))
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
    // 创建成功、首条消息失败时，侧栏也应能看到这段已存在的对话。
    onSettled: () => refreshConversationLists(queryClient),
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

/** 两处归属分别调用端点；结束后不论成败自己刷新对话列表，``onSaved`` 只管调用方的收尾。 */
export const useSetConversationMembership = (
  onSaved?: () => void,
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
    // 两个独立归属请求可能部分成功；失败也复核服务端实际状态。
    onSettled: () => refreshConversationLists(queryClient),
    onSuccess: () => onSaved?.(),
  })
}

/** 从某一轮岔出一段自己的对话。源对话不变，副本带着截到那一轮的历史、工作区与已出片的记录。
 *
 * 副本 id 由服务端铸、没有幂等键，重发就是第二段。成功之后不复位标记：那一刻请求已经回来、
 * 按钮又能点了，但页面还在跳去副本的路上，这个窗口里再点一下就是第二段。失败才放开重试。 */
export const useForkConversation = (onForked: (conversationId: string) => void) => {
  const queryClient = useQueryClient()
  const inFlightRef = useRef(false)
  const mutation = useMutation({
    mutationFn: ({ conversationId, turn }: { conversationId: string; turn: number }) =>
      apiFetch(`/conversations/${conversationId}:fork`, conversationEnvelopeSchema, {
        body: { turn },
        fallbackErrorMessage: '分叉失败',
        method: 'POST',
      }),
    onError: () => {
      inFlightRef.current = false
    },
    onSuccess: async (conversation) => {
      await refreshConversationLists(queryClient)
      onForked(conversation.id)
    },
  })
  const start = (input: { conversationId: string; turn: number }): Promise<void> => {
    if (inFlightRef.current) return Promise.resolve()
    inFlightRef.current = true
    return mutation.mutateAsync(input).then(() => undefined)
  }
  return { isPending: mutation.isPending, start }
}

/** 改名；成功后自己刷新对话列表。 */
export const useRenameConversation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
      apiFetch(`/conversations/${conversationId}`, conversationEnvelopeSchema, {
        body: { title },
        fallbackErrorMessage: '重命名失败',
        method: 'PATCH',
      }),
    onSuccess: () => refreshConversationLists(queryClient),
  })
}

/** 属主标记这段对话收尾了或取消；服务端不会自己标，属主再动手会自动取消。成功后自己刷新对话列表。 */
export const useSetConversationCompletion = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ completed, conversationId }: { completed: boolean; conversationId: string }) =>
      apiFetch(`/conversations/${conversationId}/completion`, conversationEnvelopeSchema, {
        body: { completed },
        fallbackErrorMessage: '标记完成失败',
        method: 'PUT',
      }),
    onSuccess: () => refreshConversationLists(queryClient),
  })
}

/** 删除返回 204，无响应正文；成功后自己刷新对话列表。 */
export const useDeleteConversation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (conversationId: string) =>
      apiFetch(`/conversations/${conversationId}`, z.unknown(), {
        fallbackErrorMessage: '删除失败',
        method: 'DELETE',
      }),
    onSuccess: () => refreshConversationLists(queryClient),
  })
}
