/** 宿主与渲染器共用文件查询键，event.fs.changed 仅失效对应文件。 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zConversationFileEnvelope, zConversationFilesOut } from '@/shared/api/generated/zod.gen'

export const workspaceQueryKeys = {
  file: (conversationId: string, path: string) =>
    ['conversations', conversationId, 'workspace', 'file', path] as const,
  files: (conversationId: string) =>
    ['conversations', conversationId, 'workspace', 'files'] as const,
}

export const useWorkspaceFiles = (conversationId: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(`/conversations/${conversationId}/workspace/files`, zConversationFilesOut, {
        fallbackErrorMessage: '读取工作区文件失败',
        signal,
      }),
    queryKey: workspaceQueryKeys.files(conversationId),
  })

/** 整份写回须携带读取版本；409 时由调用方重拉处理，成功返回递增后的版本。 */
export const writeWorkspaceFile = (
  conversationId: string,
  body: { path: string; content: string; expectedVersion: number },
) =>
  apiFetch(`/conversations/${conversationId}/workspace/file`, zConversationFileEnvelope, {
    body,
    fallbackErrorMessage: '保存失败',
    method: 'PUT',
  })

export const readWorkspaceFile = (conversationId: string, path: string, signal?: AbortSignal) =>
  apiFetch(
    `/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(path)}`,
    zConversationFileEnvelope,
    { fallbackErrorMessage: '读取工作区文件失败', ...(signal === undefined ? {} : { signal }) },
  )

export const useWorkspaceFile = (conversationId: string, path: string) =>
  useQuery({
    queryFn: ({ signal }) => readWorkspaceFile(conversationId, path, signal),
    queryKey: workspaceQueryKeys.file(conversationId, path),
  })
