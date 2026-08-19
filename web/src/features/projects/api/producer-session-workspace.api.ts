import { z } from 'zod'
import type {
  ProducerSessionWorkspaceDocument,
  ProducerSessionWorkspaceFileUpdate,
  ReplaceProducerSessionWorkspaceFileInput,
} from '@/features/projects/producer-project.types'
import { apiFetch, apiFetchWithResponse } from '@/shared/api/client'
import { requiredStringSchema } from '@/shared/api/schemas'

const producerSessionWorkspaceFilesSchema = z.object(
  {
    files: z.array(requiredStringSchema('Session Workspace 文件路径不能为空'), {
      error: 'Session Workspace 文件列表格式无效',
    }),
  },
  { error: 'Session Workspace 文件列表响应格式无效' },
)

const producerSessionWorkspaceFileSchema = z.object(
  {
    content: z.string({ error: 'Session Workspace 文件内容必须是字符串' }),
  },
  { error: 'Session Workspace 文件响应格式无效' },
)

const workspaceFilePath = (sessionId: string, path: string) => {
  const query = new URLSearchParams({ path })

  return `/sessions/${encodeURIComponent(sessionId)}/workspace/file?${query.toString()}`
}

const requiredWorkspaceEtag = (response: Response, operation: '读取' | '修改') => {
  const etag = response.headers.get('ETag')

  if (!etag) {
    throw new Error(`${operation} Session Workspace 文件响应缺少 ETag`)
  }

  return etag
}

/**
 * 列出当前 session Workspace 中的逻辑文件路径。
 *
 * @param sessionId - Agno session id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns Workspace 中的逻辑文件路径。
 */
export const listProducerSessionWorkspaceFiles = async (
  sessionId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/sessions/${encodeURIComponent(sessionId)}/workspace/files`,
      producerSessionWorkspaceFilesSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载 Session Workspace 文件列表失败',
        signal,
      },
    )
  ).files

/**
 * 读取当前 session Workspace 中的单个逻辑文件及其并发版本。
 *
 * @param sessionId - Agno session id。
 * @param path - Workspace 内逻辑路径。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 文件路径、内容和后端返回的 opaque ETag。
 */
export const readProducerSessionWorkspaceFile = async (
  sessionId: string,
  path: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProducerSessionWorkspaceDocument> => {
  const { data, response } = await apiFetchWithResponse(
    workspaceFilePath(sessionId, path),
    producerSessionWorkspaceFileSchema,
    {
      cache: 'no-store',
      fallbackErrorMessage: '读取 Session Workspace 文件失败',
      signal,
    },
  )

  return {
    content: data.content,
    etag: requiredWorkspaceEtag(response, '读取'),
    path,
  }
}

/**
 * 使用读取时取得的 ETag 原子替换当前 session Workspace 文件。
 *
 * @param sessionId - Agno session id。
 * @param path - Workspace 内逻辑路径。
 * @param input - 新内容与读取时取得的 opaque ETag。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 文件路径和更新后响应中的新 opaque ETag。
 */
export const replaceProducerSessionWorkspaceFile = async (
  sessionId: string,
  path: string,
  input: ReplaceProducerSessionWorkspaceFileInput,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProducerSessionWorkspaceFileUpdate> => {
  const { response } = await apiFetchWithResponse(
    workspaceFilePath(sessionId, path),
    z.undefined(),
    {
      body: { content: input.content },
      cache: 'no-store',
      fallbackErrorMessage: '修改 Session Workspace 文件失败',
      headers: { 'If-Match': input.etag },
      method: 'PUT',
      signal,
    },
  )

  return {
    etag: requiredWorkspaceEtag(response, '修改'),
    path,
  }
}
