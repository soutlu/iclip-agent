/**
 * 工作区文件的读取面：文件列表与单份内容。
 *
 * 两处共用同一套查询键——宿主按列表合成产物，渲染器读自己那一份内容，收到 `event.fs.changed`
 * 时只失效那一个键。
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zConversationFileEnvelope, zConversationFilesOut } from '@/shared/api/generated/zod.gen'

export const workspaceQueryKeys = {
  file: (conversationId: string, path: string) =>
    ['conversations', conversationId, 'workspace', 'file', path] as const,
  files: (conversationId: string) =>
    ['conversations', conversationId, 'workspace', 'files'] as const,
}

/** 这段对话里 agent 写下的文件清单。 */
export const useWorkspaceFiles = (conversationId: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(`/conversations/${conversationId}/workspace/files`, zConversationFilesOut, {
        fallbackErrorMessage: '读取工作区文件失败',
        signal,
      }),
    queryKey: workspaceQueryKeys.files(conversationId),
  })

/**
 * 整份写回一个工作区文件。带上读到那一份的版本号：对不上服务端回 409，调用方据此重拉再决定。
 *
 * @param conversationId - 哪一段对话。
 * @param body - 路径、新正文、读到的版本。
 * @returns 写下之后那一份（版本已加一）。
 */
export const writeWorkspaceFile = (
  conversationId: string,
  body: { path: string; content: string; expectedVersion: number },
) =>
  apiFetch(`/conversations/${conversationId}/workspace/file`, zConversationFileEnvelope, {
    body,
    fallbackErrorMessage: '保存失败',
    method: 'PUT',
  })

/** 读一份工作区文件的正文与版本号。 */
export const readWorkspaceFile = (conversationId: string, path: string, signal?: AbortSignal) =>
  apiFetch(
    `/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(path)}`,
    zConversationFileEnvelope,
    { fallbackErrorMessage: '读取工作区文件失败', ...(signal === undefined ? {} : { signal }) },
  )

/** 一份工作区文件的正文与版本号。 */
export const useWorkspaceFile = (conversationId: string, path: string) =>
  useQuery({
    queryFn: ({ signal }) => readWorkspaceFile(conversationId, path, signal),
    queryKey: workspaceQueryKeys.file(conversationId, path),
  })
