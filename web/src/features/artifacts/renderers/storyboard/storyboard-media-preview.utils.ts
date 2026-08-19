import type { StoryboardFrameImageEntry } from '@/features/artifacts/renderers/storyboard/storyboard-frame-image.types'
import {
  getStoryboardRowLabel,
  getStoryboardVideoLabel,
  hasText,
} from '@/features/artifacts/renderers/storyboard/storyboard-table-config'
import type { StoryboardShot } from '@/features/artifacts/types/storyboard.types'
import type { MediaPreviewItem } from '@/shared/ui/media'

export const storyboardFrameImageToPreviewItem = (
  image: StoryboardFrameImageEntry,
  shot: StoryboardShot,
): MediaPreviewItem => ({
  altText: image.alt,
  fileName: `${getStoryboardRowLabel(shot)} · ${image.orderLabel}`,
  mediaType: 'image',
  thumbnailUrl: image.url,
  url: image.url,
})

export const storyboardVideoToPreviewItem = (shot: StoryboardShot): MediaPreviewItem | null => {
  if (!hasText(shot.videoUrl)) {
    return null
  }

  return {
    fileName: getStoryboardVideoLabel(shot),
    mediaType: 'video',
    url: shot.videoUrl,
  }
}
