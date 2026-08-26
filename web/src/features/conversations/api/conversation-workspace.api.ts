/**
 * 一段对话的工作区文件（后端合同见仓库根 `contract/conventions.md` §6）。
 *
 * 这些是 agent 在这段对话里用工作区工具写下的文本文件，只读。列表带 `version`，
 * 版本没变内容就没变——调用方据此决定要不要重读正文。
 */

import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { requiredStringSchema } from '@/shared/api/schemas'

const conversationWorkspaceFileSchema = z.object({
  path: requiredStringSchema('工作区文件缺少 path'),
  sizeBytes: z.number(),
  updatedAt: z.string(),
  version: z.number(),
})

export type ConversationWorkspaceFile = z.infer<typeof conversationWorkspaceFileSchema>

const conversationWorkspaceFilesResponseSchema = z.object({
  files: z.array(conversationWorkspaceFileSchema, { error: '工作区文件列表响应缺少 files 数组' }),
})

const conversationWorkspaceFileContentSchema = z.object({
  content: z.string(),
  path: requiredStringSchema('工作区文件缺少 path'),
  version: z.number(),
})

export type ConversationWorkspaceFileContent = z.infer<
  typeof conversationWorkspaceFileContentSchema
>

const conversationWorkspaceFileResponseSchema = z.object({
  file: conversationWorkspaceFileContentSchema,
})

const conversationWorkspacePath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}/workspace`

/**
 * 列出这段对话里写下的文件，按路径排序；一份都没写过是空数组。
 *
 * @param conversationId - 对话 id。
 * @returns 文件元信息列表。
 */
export const listConversationWorkspaceFiles = async (
  conversationId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ConversationWorkspaceFile[]> =>
  (
    await apiFetch(
      `${conversationWorkspacePath(conversationId)}/files`,
      conversationWorkspaceFilesResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载工作区文件列表失败',
        signal,
      },
    )
  ).files

/**
 * 读其中一个文件的全文。路径放查询串：文件路径自己就带 `/`。
 *
 * @param conversationId - 对话 id。
 * @param path - 列表里给的路径。
 * @returns 文件全文与版本号。
 */
export const readConversationWorkspaceFile = async (
  conversationId: string,
  path: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ConversationWorkspaceFileContent> =>
  (
    await apiFetch(
      `${conversationWorkspacePath(conversationId)}/file?${new URLSearchParams({ path })}`,
      conversationWorkspaceFileResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '读取工作区文件失败',
        signal,
      },
    )
  ).file
