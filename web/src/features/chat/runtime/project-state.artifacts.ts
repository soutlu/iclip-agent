import {
  type GeneratedVideoStatus,
  getProjectArtifactIdentity,
  IMAGE_ANALYSIS_SUMMARY_ARTIFACT_ID,
  type ProjectArtifactDescriptor,
  projectArtifactFromPayload,
} from '@/features/artifacts'
import type { ProducerProjectMediaItem } from '@/features/chat/project-state.types'
import { producerVideoOutputAssetsByGenerationId } from '@/features/projects'
import { isRecord, nonEmptyString } from '@/shared/lib/guards'
import {
  GENERATED_VIDEO_ARTIFACT_ID,
  MARKDOWN_EXTENSIONS,
  requiredString,
  requiredTimestampIsoString,
  VIDEO_SHOT_PATH,
  type WorkspaceDocument,
} from './project-state.readers'

export interface ImageAnalysisSummaryItem {
  category: string
  description: string
  filename?: string
  key: string
  thumbnailUrl?: string
  url?: string
}

export const pathTitle = (path: string) => {
  const fileName = path.split('/').at(-1)?.trim()

  return fileName && fileName.length > 0 ? fileName : path
}

export const isMarkdownPath = (path: string) =>
  MARKDOWN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))

export const workspaceArtifactId = (path: string) => `workspace:${path}`

export const markdownArtifactFromDocument = (
  document: WorkspaceDocument,
  sourceMedia?: ProducerProjectMediaItem,
  title?: string,
): ProjectArtifactDescriptor => ({
  artifactId: workspaceArtifactId(document.path),
  kind: 'markdown',
  output: {
    markdown: document.content,
    ...(sourceMedia ? { sourceMedia } : {}),
    title: title ?? pathTitle(document.path),
  },
})

export const parseJsonRecord = (content: string, label: string) => {
  const parsed = JSON.parse(content) as unknown

  if (!isRecord(parsed)) {
    throw new Error(`${label} 必须是 JSON object`)
  }

  return parsed
}

export const videoPromptArtifactFromDocument = (
  document: WorkspaceDocument,
): ProjectArtifactDescriptor => {
  const artifactId = workspaceArtifactId(document.path)
  const payload = parseJsonRecord(document.content, `Workspace ${document.path}`)
  const artifactDescriptor = projectArtifactFromPayload({
    data: payload,
    id: artifactId,
    kind: 'video-prompt',
  })

  if (!artifactDescriptor) {
    throw new Error(`Workspace video shot 格式无效: ${document.path}`)
  }

  return artifactDescriptor
}

export const cleanMarkdownLine = (value: string) =>
  value
    .replaceAll('**', '')
    .replace(/^#+\s*/u, '')
    .replace(/^[-*]\s*/u, '')
    .trim()

export const markdownLabelValue = (markdown: string, label: string) => {
  for (const line of markdown.split(/\r?\n/u)) {
    const cleanedLine = cleanMarkdownLine(line)
    const chinesePrefix = `${label}：`
    const asciiPrefix = `${label}:`

    if (cleanedLine.startsWith(chinesePrefix)) {
      return cleanedLine.slice(chinesePrefix.length).trim() || undefined
    }

    if (cleanedLine.startsWith(asciiPrefix)) {
      return cleanedLine.slice(asciiPrefix.length).trim() || undefined
    }
  }

  return undefined
}

export const firstMarkdownDescriptionLine = (markdown: string) => {
  for (const line of markdown.split(/\r?\n/u)) {
    const cleanedLine = cleanMarkdownLine(line)

    if (
      cleanedLine.length === 0 ||
      cleanedLine.startsWith('图片理解') ||
      cleanedLine.startsWith('分类：') ||
      cleanedLine.startsWith('分类:')
    ) {
      continue
    }

    return cleanedLine
  }

  return undefined
}

interface CanonicalMediaDocumentReference {
  assetId: string
  kind: 'image' | 'video'
}

export const canonicalMediaDocumentReference = (
  path: string,
): CanonicalMediaDocumentReference | null => {
  const matched = /^(image|video)\/([0-9a-f]{32})\.md$/u.exec(path)

  if (!matched) {
    return null
  }

  return {
    assetId: requiredString(matched[2], `Workspace path ${path} asset id`),
    kind: matched[1] as CanonicalMediaDocumentReference['kind'],
  }
}

const sourceMediaFromWorkspaceDocument = ({
  allAssetIds,
  allMediaByAssetId,
  document,
}: {
  allAssetIds: Set<string>
  allMediaByAssetId: Map<string, ProducerProjectMediaItem>
  document: WorkspaceDocument
}): {
  reference: CanonicalMediaDocumentReference
  sourceMedia: ProducerProjectMediaItem
} | null => {
  const reference = canonicalMediaDocumentReference(document.path)

  if (!reference) {
    return null
  }

  if (!allAssetIds.has(reference.assetId)) {
    throw new Error(
      `Workspace 文件 ${document.path} 引用未知 ${reference.kind} asset: ${reference.assetId}`,
    )
  }

  const sourceMedia = allMediaByAssetId.get(reference.assetId)

  if (!sourceMedia) {
    throw new Error(
      `Workspace 文件 ${document.path} 引用的 asset 不是可用的 upload/import 媒体: ${reference.assetId}`,
    )
  }

  if (sourceMedia.kind !== reference.kind) {
    throw new Error(
      `Workspace 文件 ${document.path} 引用的 asset 类型应为 ${reference.kind}: ${reference.assetId}`,
    )
  }

  return { reference, sourceMedia }
}

export const imageAnalysisSummaryArtifactFromDocuments = ({
  allAssetIds,
  allMediaByAssetId,
  workspaceDocuments,
}: {
  allAssetIds: Set<string>
  allMediaByAssetId: Map<string, ProducerProjectMediaItem>
  workspaceDocuments: WorkspaceDocument[]
}): ProjectArtifactDescriptor | null => {
  const items = workspaceDocuments.flatMap<ImageAnalysisSummaryItem>((document) => {
    const resolved = sourceMediaFromWorkspaceDocument({
      allAssetIds,
      allMediaByAssetId,
      document,
    })

    if (resolved?.reference.kind !== 'image') {
      return []
    }

    const { sourceMedia } = resolved

    return [
      {
        category: markdownLabelValue(document.content, '分类') ?? '图片',
        description:
          markdownLabelValue(document.content, '画面主体') ??
          firstMarkdownDescriptionLine(document.content) ??
          sourceMedia.key,
        filename: sourceMedia.key,
        key: sourceMedia.key,
        ...(sourceMedia.thumbnailUrl ? { thumbnailUrl: sourceMedia.thumbnailUrl } : {}),
        url: sourceMedia.url,
      },
    ]
  })

  if (items.length === 0) {
    return null
  }

  return projectArtifactFromPayload({
    data: {
      items,
    },
    id: IMAGE_ANALYSIS_SUMMARY_ARTIFACT_ID,
    kind: 'image-analysis-summary',
  })
}

export const artifactsFromWorkspaceDocuments = ({
  allAssetIds,
  allMediaByAssetId,
  workspaceDocuments,
}: {
  allAssetIds: Set<string>
  allMediaByAssetId: Map<string, ProducerProjectMediaItem>
  workspaceDocuments: WorkspaceDocument[]
}) => {
  const descriptors: ProjectArtifactDescriptor[] = []
  const imageAnalysisSummary = imageAnalysisSummaryArtifactFromDocuments({
    allAssetIds,
    allMediaByAssetId,
    workspaceDocuments,
  })
  let didInsertImageAnalysisSummary = false

  for (const document of workspaceDocuments) {
    if (document.path === VIDEO_SHOT_PATH) {
      descriptors.push(videoPromptArtifactFromDocument(document))
      continue
    }

    const resolved = sourceMediaFromWorkspaceDocument({
      allAssetIds,
      allMediaByAssetId,
      document,
    })

    if (resolved?.reference.kind === 'image') {
      if (imageAnalysisSummary && !didInsertImageAnalysisSummary) {
        descriptors.push(imageAnalysisSummary)
        didInsertImageAnalysisSummary = true
      }
      continue
    }

    descriptors.push(markdownArtifactFromDocument(document, resolved?.sourceMedia))
  }

  return descriptors
}

export const generatedVideoStatus = (status: string): GeneratedVideoStatus => {
  switch (status) {
    case 'created':
      return 'queued'
    case 'submitted':
      return 'running'
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    default:
      throw new Error(`未知视频生成状态: ${status}`)
  }
}

export const generationErrorMessage = (generation: Record<string, unknown>) => {
  const errorMessage =
    nonEmptyString(generation.errorMessage) ?? nonEmptyString(generation.errorCode)

  if (errorMessage) {
    return errorMessage
  }

  if (!isRecord(generation.error)) {
    return undefined
  }

  return nonEmptyString(generation.error.message) ?? nonEmptyString(generation.error.code)
}

export const generationRequestPayload = (
  generation: Record<string, unknown>,
  generationId: string,
) => {
  if (!isRecord(generation.requestPayload)) {
    throw new Error(`业务数据 generation(${generationId}) 缺少 requestPayload`)
  }

  return generation.requestPayload
}

export const generationVideoShotIndex = (
  generation: Record<string, unknown>,
  generationId: string,
) => {
  const requestPayload = generationRequestPayload(generation, generationId)
  const params = requestPayload.params

  if (!isRecord(params)) {
    throw new Error(`业务数据 generation(${generationId}).requestPayload.params 必须是对象`)
  }

  const shotIndex = params.shotIndex

  if (typeof shotIndex !== 'number' || !Number.isInteger(shotIndex) || shotIndex <= 0) {
    throw new Error(
      `业务数据 generation(${generationId}).requestPayload.params.shotIndex 必须是正整数`,
    )
  }

  return shotIndex
}

export const generatedVideoArtifactFromGenerations = ({
  assets,
  generations,
}: {
  assets: Record<string, unknown>[]
  generations: Record<string, unknown>[]
}): ProjectArtifactDescriptor | null => {
  const outputAssetsByGenerationId = producerVideoOutputAssetsByGenerationId(assets)
  const items = generations.flatMap((generation) => {
    if (nonEmptyString(generation.assetType) !== 'video') {
      return []
    }

    const generationId = requiredString(generation.id, 'generation.id')
    const outputAsset = outputAssetsByGenerationId.get(generationId)
    const providerTaskId = nonEmptyString(generation.providerTaskId)
    const error = generationErrorMessage(generation)
    const status = generatedVideoStatus(
      requiredString(generation.status, `generation(${generationId}).status`),
    )

    if (status === 'succeeded' && !outputAsset) {
      throw new Error(`业务数据 generation(${generationId}) 已完成但缺少 output asset`)
    }

    const shotIndex = generationVideoShotIndex(generation, generationId)

    return [
      {
        created_at: requiredTimestampIsoString(
          generation.createdAt,
          `generation(${generationId}).createdAt`,
        ),
        ...(error ? { error } : {}),
        generation_id: generationId,
        ...(outputAsset ? { output_url: outputAsset.url } : {}),
        prompt_index: shotIndex,
        status,
        ...(providerTaskId ? { task_id: providerTaskId } : {}),
      },
    ]
  })

  if (items.length === 0) {
    return null
  }

  return projectArtifactFromPayload({
    data: {
      items,
    },
    id: GENERATED_VIDEO_ARTIFACT_ID,
    kind: 'generated-video',
  })
}

export const dedupeArtifactsByIdentity = (artifacts: ProjectArtifactDescriptor[]) => {
  const artifactsByIdentity = new Map<string, ProjectArtifactDescriptor>()

  for (const artifact of artifacts) {
    artifactsByIdentity.set(getProjectArtifactIdentity(artifact), artifact)
  }

  return [...artifactsByIdentity.values()]
}

/**
 * 将项目媒体记录转换成 composer 可复用的远端附件引用。
 *
 * @param item - 后端 session assets 接口中的输入媒体项。
 * @returns composer 可展示和提交的媒体引用。
 */
