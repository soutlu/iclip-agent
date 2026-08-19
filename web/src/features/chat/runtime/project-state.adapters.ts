import type { ProjectArtifactDescriptor } from '@/features/artifacts'
import type {
  ProducerProjectMediaItem,
  ProducerProjectMediaKind,
} from '@/features/chat/project-state.types'
import type { ComposerMediaReference } from '@/shared/composer/composer.types'
import type { MediaComposerLibraryMedia } from '@/shared/composer/media-composer'
import { isRecord, nonEmptyString } from '@/shared/lib/guards'
import {
  artifactsFromWorkspaceDocuments,
  dedupeArtifactsByIdentity,
  generatedVideoArtifactFromGenerations,
} from './project-state.artifacts'
import { recordArray, requiredString, type WorkspaceDocument } from './project-state.readers'
import { createOssVideoSnapshotUrl } from '@/shared/ui/media'

export interface ProducerProjectStateSnapshot {
  artifacts: ProjectArtifactDescriptor[]
  assets: Record<string, unknown>[]
  media: ProducerProjectMediaItem[]
}

interface SessionWorkspaceSources {
  assets: Record<string, unknown>[]
  generations: Record<string, unknown>[]
  workspaceDocuments: WorkspaceDocument[]
}

interface AssetMediaIndexes {
  allAssetIds: Set<string>
  allMediaByAssetId: Map<string, ProducerProjectMediaItem>
  inputMedia: ProducerProjectMediaItem[]
}

const workspaceDocumentsFromUnknown = (value: unknown): WorkspaceDocument[] => {
  if (!Array.isArray(value)) {
    throw new Error('Workspace documents 必须是数组')
  }

  return value.map((document, index) => {
    if (!isRecord(document)) {
      throw new Error(`Workspace documents[${index}] 必须是对象`)
    }
    if (typeof document.content !== 'string') {
      throw new Error(`Workspace data workspaceDocuments[${index}].content 必须是字符串`)
    }

    return {
      content: document.content,
      etag: requiredString(document.etag, `workspaceDocuments[${index}].etag`),
      path: requiredString(document.path, `workspaceDocuments[${index}].path`),
    }
  })
}

const sessionWorkspaceSourcesFromUnknown = (data: unknown): SessionWorkspaceSources => {
  if (!isRecord(data)) {
    throw new Error('Workspace data 响应必须是对象')
  }

  return {
    assets: recordArray(data.assets, 'assets'),
    generations: recordArray(data.generations, 'generations'),
    workspaceDocuments: workspaceDocumentsFromUnknown(data.workspaceDocuments),
  }
}

const mediaKindFromAsset = (asset: Record<string, unknown>): ProducerProjectMediaKind | null => {
  const assetType = nonEmptyString(asset.assetType)

  if (assetType === 'image' || assetType === 'video') {
    return assetType
  }

  return null
}

const isInputAsset = (asset: Record<string, unknown>) => {
  const source = nonEmptyString(asset.source)

  return source === 'upload' || source === 'import'
}

const optionalAssetMetadataString = (asset: Record<string, unknown>, fields: string[]) => {
  const metadata = isRecord(asset.metadata) ? asset.metadata : {}

  for (const field of fields) {
    const value = nonEmptyString(metadata[field])

    if (value) {
      return value
    }
  }

  return undefined
}

const mediaKeyFromAssetMetadata = ({
  asset,
  kind,
}: {
  asset: Record<string, unknown>
  kind: ProducerProjectMediaKind
}) => {
  const filename = optionalAssetMetadataString(asset, ['filename'])

  if (!filename) {
    return undefined
  }

  const pattern = kind === 'image' ? /^image_\d+$/u : /^video_\d+$/u

  return pattern.test(filename) ? filename : undefined
}

const mediaItemFromAsset = ({
  asset,
  fallbackKey,
}: {
  asset: Record<string, unknown>
  fallbackKey: string
}): ProducerProjectMediaItem | null => {
  const assetId = requiredString(asset.id, 'asset.id')
  const kind = mediaKindFromAsset(asset)

  if (!kind) {
    return null
  }

  const key = mediaKeyFromAssetMetadata({ asset, kind }) ?? fallbackKey
  const url = requiredString(asset.url, `asset(${assetId}).url`)
  const thumbnailUrl = optionalAssetMetadataString(asset, ['thumbnailUrl', 'thumbnail_url'])
  const ossUrl = optionalAssetMetadataString(asset, ['ossUrl', 'oss_url'])

  return {
    assetId,
    filename: key,
    key,
    kind,
    ...(ossUrl ? { ossUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    url,
  }
}

const assetMediaIndexes = ({
  assets,
}: {
  assets: Record<string, unknown>[]
}): AssetMediaIndexes => {
  const allAssetIds = new Set<string>()
  const allMediaByAssetId = new Map<string, ProducerProjectMediaItem>()
  const inputMedia: ProducerProjectMediaItem[] = []
  const inputCounters: Record<ProducerProjectMediaKind, number> = { image: 0, video: 0 }

  for (const asset of assets) {
    allAssetIds.add(requiredString(asset.id, 'asset.id'))
  }

  for (const asset of assets) {
    if (!isInputAsset(asset)) {
      continue
    }

    const kind = mediaKindFromAsset(asset)

    if (!kind) {
      continue
    }

    inputCounters[kind] += 1
    const item = mediaItemFromAsset({
      asset,
      fallbackKey: `${kind}_${inputCounters[kind]}`,
    })

    if (item) {
      inputMedia.push(item)
      allMediaByAssetId.set(requiredString(asset.id, 'asset.id'), item)
    }
  }

  return {
    allAssetIds,
    allMediaByAssetId,
    inputMedia,
  }
}

export const producerProjectMediaToComposerReference = (
  item: ProducerProjectMediaItem,
): ComposerMediaReference => ({
  attachmentId: item.key,
  fileName: item.key,
  mediaType: item.kind,
  thumbnailUrl:
    item.thumbnailUrl ??
    (item.kind === 'image' ? item.url : createOssVideoSnapshotUrl(item.ossUrl ?? item.url)),
  url: item.url,
})

/**
 * 把项目媒体事实转换为 Media Composer 的稳定引用目录项。
 *
 * @param item - 从 session asset 事实投影出的项目媒体。
 * @returns 使用持久化 asset id 标识的 Tiptap 引用目录项。
 */
export const producerProjectMediaToMediaComposerLibraryMedia = (
  item: ProducerProjectMediaItem,
): MediaComposerLibraryMedia => {
  if (!item.assetId) {
    throw new Error(`项目媒体 ${item.key} 缺少稳定 asset id`)
  }

  return {
    assetId: item.assetId,
    displayName: item.filename ?? item.key,
    kind: item.kind,
    previewUrl:
      item.thumbnailUrl ??
      (item.kind === 'image' ? item.url : createOssVideoSnapshotUrl(item.ossUrl ?? item.url)),
    promptKey: item.key,
    url: item.url,
  }
}

/**
 * 从 session Workspace、素材与生成事实恢复媒体和 artifact 视图数据。
 *
 * @param params - Workspace 数据转换参数。
 * @param params.data - Workspace documents、session assets 与 generation 事实。
 * @returns 前端项目状态快照。
 */
export const producerSessionWorkspaceSourcesToSnapshot = ({
  data,
}: {
  data: unknown
}): ProducerProjectStateSnapshot => {
  const payload = sessionWorkspaceSourcesFromUnknown(data)
  const { allAssetIds, allMediaByAssetId, inputMedia } = assetMediaIndexes({
    assets: payload.assets,
  })
  const generatedVideoArtifact = generatedVideoArtifactFromGenerations({
    assets: payload.assets,
    generations: payload.generations,
  })

  return {
    artifacts: dedupeArtifactsByIdentity([
      ...artifactsFromWorkspaceDocuments({
        allAssetIds,
        allMediaByAssetId,
        workspaceDocuments: payload.workspaceDocuments,
      }),
      ...(generatedVideoArtifact ? [generatedVideoArtifact] : []),
    ]),
    assets: payload.assets,
    media: inputMedia,
  }
}
