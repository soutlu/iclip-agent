import type { VideoPromptBatch } from '@/features/artifacts/types/video-prompt.types'

export const createVideoBatchKey = (batch: VideoPromptBatch) => String(batch.index)

export const formatVideoBatchSecond = (second: number | undefined) => {
  if (!second || second <= 0) {
    return null
  }

  return `${second}s`
}

export const formatVideoBatchShotLabel = (batch: VideoPromptBatch) => {
  if (!batch.sourceShotIndices || batch.sourceShotIndices.length === 0) {
    return null
  }

  return batch.sourceShotIndices.map((shot) => `分镜 ${String(shot).padStart(2, '0')}`).join(' / ')
}
