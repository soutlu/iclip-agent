export type MediaPreviewType = 'audio' | 'image' | 'video'

export type ImagePreviewMode = 'actual' | 'fit'

export interface MediaPreviewItem {
  attachmentId?: string
  altText?: string
  fileName: string
  mediaType: MediaPreviewType
  thumbnailUrl?: string
  url: string
}
