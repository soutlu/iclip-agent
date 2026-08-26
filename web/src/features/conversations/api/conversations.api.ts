/**
 * 对话的接口层（后端合同见仓库根 `contract/conventions.md` §6）。
 *
 * 对话 id 由服务端发放，客户端拿它当 AG-UI 的 `threadId`；自己编一个发去跑 agent 会被
 * 当作不存在（404）。
 */

import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { requiredStringSchema } from '@/shared/api/schemas'

const conversationSchema = z.object({
  agentId: requiredStringSchema('对话缺少 agentId'),
  createdAt: z.string(),
  id: requiredStringSchema('对话缺少 id'),
  lastRunId: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  title: z.string(),
  updatedAt: z.string(),
})

export type Conversation = z.infer<typeof conversationSchema>

const conversationResponseSchema = z.object({ conversation: conversationSchema })

const conversationsPageResponseSchema = z.object({
  items: z.array(conversationSchema, { error: '对话列表响应缺少 items 数组' }),
})

/** 消息是 AG-UI 官方形状，字段名沿用 AG-UI 拼写；这里不校验内部结构，交给 runtime 还原。 */
const conversationMessagesResponseSchema = z.object({
  messages: z.array(z.unknown(), { error: '对话历史响应缺少 messages 数组' }),
})

/** 对话标题的后端上限（超了是 422）。 */
export const MAX_CONVERSATION_TITLE_CHARS = 200

export type CreateConversationInput = {
  agentId: string
  /** 放进哪个项目；之后还能换。 */
  projectId?: string
  /** 为哪张需求单而开；只在开的时候定，之后不改。 */
  taskId?: string
  title?: string
}

/**
 * 开一段新对话。
 *
 * @param input - 跑哪个 agent，以及两处可选的归属。
 * @returns 服务端发放的对话。
 */
export const createConversation = async (
  input: CreateConversationInput,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Conversation> =>
  (
    await apiFetch('/conversations', conversationResponseSchema, {
      body: input,
      cache: 'no-store',
      fallbackErrorMessage: '创建对话失败',
      method: 'POST',
      signal,
    })
  ).conversation

/**
 * 列出自己在这张需求单下开过的对话，按开始时间正序——第几次尝试就是这个顺序。
 *
 * 只列自己的：一张单人人可见，不等于这张单下面谁跑过什么也人人可见。
 *
 * @param taskId - 需求单 id。
 * @returns 这张单下自己的历次尝试。
 */
export const listTaskConversations = async (
  taskId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Conversation[]> =>
  (
    await apiFetch(
      `/conversations/by-task/${encodeURIComponent(taskId)}`,
      conversationsPageResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载这张需求单的运行记录失败',
        signal,
      },
    )
  ).items

/**
 * 读一段对话已经发生过的消息（刷新、重新登录后靠它拿回历史）。
 *
 * 返回的是服务端最新的那份存档：一次都没跑过是空数组，不是 404。
 *
 * @param conversationId - 对话 id。
 * @returns AG-UI 形状的消息列表。
 */
export const listConversationMessages = async (
  conversationId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<unknown[]> =>
  (
    await apiFetch(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      conversationMessagesResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载对话历史失败',
        signal,
      },
    )
  ).messages
