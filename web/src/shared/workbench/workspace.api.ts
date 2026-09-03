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

/** 一份工作区文件的正文与版本号。 */
export const useWorkspaceFile = (conversationId: string, path: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(
        `/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(path)}`,
        zConversationFileEnvelope,
        { fallbackErrorMessage: '读取工作区文件失败', signal },
      ),
    queryKey: workspaceQueryKeys.file(conversationId, path),
  })
