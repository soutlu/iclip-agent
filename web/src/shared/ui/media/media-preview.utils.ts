import type { ComposerFileAttachment } from '@/shared/composer/composer.types'
import type { MediaComposerReference } from '@/shared/composer/media-composer'
import type { ImagePreviewMode, MediaPreviewItem } from '@/shared/ui/media/media-preview.types'

export const IMAGE_PREVIEW_SCALE_MAX = 3
export const IMAGE_PREVIEW_SCALE_MIN = 0.5
export const IMAGE_PREVIEW_SCALE_STEP = 0.1

interface ResolveImagePreviewFitScaleOptions {
  imageHeight: number
  imageWidth: number
  viewportHeight: number
  viewportWidth: number
}

export const composerAttachmentToPreviewItem = (
  attachment: ComposerFileAttachment,
): MediaPreviewItem => ({
  attachmentId: attachment.id,
  fileName: attachment.name,
  mediaType: attachment.kind,
  thumbnailUrl: attachment.thumbnailUrl,
  url: attachment.url,
})

/**
 * 把 Tiptap Media Composer 引用转换为通用媒体预览对象。
 *
 * @param reference - 从当前 reference catalog 解析出的媒体。
 * @returns 可交给共享预览 Dialog 的对象。
 */
export const mediaComposerReferenceToPreviewItem = (
  reference: MediaComposerReference,
): MediaPreviewItem => ({
  attachmentId: reference.attachmentId,
  fileName: reference.source.displayName,
  mediaType: reference.source.kind,
  thumbnailUrl: reference.source.previewUrl,
  url: reference.source.url,
})

export const clampImagePreviewScale = (value: number) =>
  Math.min(IMAGE_PREVIEW_SCALE_MAX, Math.max(IMAGE_PREVIEW_SCALE_MIN, value))

export const getNextImagePreviewScale = (currentScale: number, wheelDeltaY: number) => {
  if (wheelDeltaY === 0) {
    return clampImagePreviewScale(currentScale)
  }

  const direction = wheelDeltaY < 0 ? 1 : -1
  return clampImagePreviewScale(currentScale + direction * IMAGE_PREVIEW_SCALE_STEP)
}

export const resolveImagePreviewFitScale = ({
  imageHeight,
  imageWidth,
  viewportHeight,
  viewportWidth,
}: ResolveImagePreviewFitScaleOptions) => {
  if (imageHeight <= 0 || imageWidth <= 0 || viewportHeight <= 0 || viewportWidth <= 0) {
    return 1
  }

  return Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight, 1)
}

export const toggleImagePreviewMode = (currentMode: ImagePreviewMode): ImagePreviewMode =>
  currentMode === 'fit' ? 'actual' : 'fit'
