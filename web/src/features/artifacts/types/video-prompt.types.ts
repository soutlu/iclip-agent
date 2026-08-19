export interface VideoPromptPreviewImage {
  key: string
  url: string
}

export interface VideoPromptBatch {
  index: number
  prompt: string
  previewImages?: VideoPromptPreviewImage[]
  referenceImages?: string[]
  second?: number
  sourceShotIndices?: number[]
}

export interface VideoPromptOutput {
  aspectRatio?: string
  batches: VideoPromptBatch[]
  summary: string
}
