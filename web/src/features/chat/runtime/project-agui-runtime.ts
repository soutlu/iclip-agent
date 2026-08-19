import type { ProjectArtifactDescriptor } from '@/features/artifacts'
import type { ProducerProjectMediaItem } from '@/features/chat/project-state.types'
import {
  listProducerSessionAssets,
  listProducerSessionGenerations,
  listProducerSessionWorkspaceFiles,
  mergeProducerGenerationRecords,
  readProducerSessionWorkspaceFile,
} from '@/features/projects'
import { isRecord } from '@/shared/lib/guards'
import { producerSessionWorkspaceSourcesToSnapshot } from './project-state.adapters'
import { isMarkdownPath } from './project-state.artifacts'
import { VIDEO_SHOT_PATH } from './project-state.readers'

interface ProjectBusinessStateSnapshot {
  artifacts: ProjectArtifactDescriptor[]
  assets: Record<string, unknown>[]
  generations: Record<string, unknown>[]
  media: ProducerProjectMediaItem[]
}

export const isVisibleWorkspaceDocumentPath = (path: string) =>
  path === VIDEO_SHOT_PATH || isMarkdownPath(path)

/**
 * 读取项目业务态（artifacts/media）。
 *
 * 业务态来自 session Workspace、assets 与 generation 查询接口。
 *
 * @param params - 业务状态请求参数。
 * @param params.generations - 可选 generation 增量事实，来自 WS 或本地提交响应。
 * @param params.sessionId - 当前 Agno session id。
 * @param params.signal - 可选取消信号。
 * @returns 项目 artifacts 与 media 快照。
 */
export const fetchProjectBusinessState = async ({
  generations = [],
  sessionId,
  signal,
}: {
  generations?: Record<string, unknown>[]
  sessionId: string
  signal?: AbortSignal
}): Promise<ProjectBusinessStateSnapshot> => {
  const workspacePathsPromise = listProducerSessionWorkspaceFiles(sessionId, { signal })
  const persistedGenerations = await listProducerSessionGenerations(sessionId, { signal })
  const [assets, workspacePaths] = await Promise.all([
    listProducerSessionAssets(sessionId, { signal }),
    workspacePathsPromise,
  ])
  const workspaceDocuments = await Promise.all(
    workspacePaths
      .filter(isVisibleWorkspaceDocumentPath)
      .map((path) => readProducerSessionWorkspaceFile(sessionId, path, { signal })),
  )
  const mergedGenerations = mergeProducerGenerationRecords(persistedGenerations, generations)
  const snapshot = producerSessionWorkspaceSourcesToSnapshot({
    data: {
      assets,
      generations: mergedGenerations,
      workspaceDocuments,
    },
  })

  return {
    ...snapshot,
    generations: mergedGenerations,
  }
}

/**
 * 判断未知值是否是 ask_user_question 输出。
 *
 * @param value - 需要检查的提交值。
 * @returns 值包含 answers 记录时返回 true。
 */
export const isAskUserQuestionToolOutput = (
  value: unknown,
): value is { answers: Record<string, unknown> } => isRecord(value) && isRecord(value.answers)
