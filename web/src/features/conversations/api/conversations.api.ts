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

/** 消息是 AG-UI 官方形状，字段名沿用 AG-UI 拼写；这里不校验内部结构，交给 runtime 还原。 */
const conversationMessagesResponseSchema = z.object({
  messages: z.array(z.unknown(), { error: '对话历史响应缺少 messages 数组' }),
})

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
