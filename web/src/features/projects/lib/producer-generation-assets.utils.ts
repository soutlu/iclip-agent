import { isRecord, nonEmptyString } from '@/shared/lib/guards'

export interface ProducerVideoOutputAsset {
  id: string
  generationJobId: string
  mimeType?: string
  thumbnailUrl?: string
  url: string
}

const assetMetadataString = (asset: Record<string, unknown>, fields: string[]) => {
  const metadata = isRecord(asset.metadata) ? asset.metadata : {}

  for (const field of fields) {
    const value = nonEmptyString(metadata[field])

    if (value) {
      return value
    }
  }

  return undefined
}

const videoOutputAssetFromRecord = (
  asset: Record<string, unknown>,
): ProducerVideoOutputAsset | null => {
  if (nonEmptyString(asset.assetType) !== 'video') {
    return null
  }

  const generationJobId = nonEmptyString(asset.generationJobId)

  if (!generationJobId) {
    return null
  }

  const id = nonEmptyString(asset.id)
  const url = nonEmptyString(asset.url)

  if (!id || !url) {
    throw new Error(
      `Productor data generation(${generationJobId}) 的 video output asset 缺少 id 或 url`,
    )
  }

  const mimeType = nonEmptyString(asset.mimeType)
  const thumbnailUrl = assetMetadataString(asset, ['thumbnailUrl', 'thumbnail_url'])

  return {
    generationJobId,
    id,
    ...(mimeType ? { mimeType } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    url,
  }
}

/**
 * 按 generationJobId 索引已经登记的 video output asset。
 *
 * @param assets - 后端 media_assets 原始记录。
 * @returns generation job id 到 video output asset 的索引。
 */
export const producerVideoOutputAssetsByGenerationId = (assets: Record<string, unknown>[]) => {
  const outputAssetsByGenerationId = new Map<string, ProducerVideoOutputAsset>()

  for (const asset of assets) {
    const outputAsset = videoOutputAssetFromRecord(asset)

    if (!outputAsset) {
      continue
    }

    if (outputAssetsByGenerationId.has(outputAsset.generationJobId)) {
      throw new Error(
        `Productor data generation(${outputAsset.generationJobId}) 存在重复 video output asset`,
      )
    }

    outputAssetsByGenerationId.set(outputAsset.generationJobId, outputAsset)
  }

  return outputAssetsByGenerationId
}
