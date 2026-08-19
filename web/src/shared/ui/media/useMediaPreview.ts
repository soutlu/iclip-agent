import { useCallback, useState } from 'react'
import type { MediaPreviewItem } from '@/shared/ui/media/media-preview.types'

export default function useMediaPreview() {
  const [preview, setPreview] = useState<MediaPreviewItem | null>(null)

  const closePreview = useCallback(() => {
    setPreview(null)
  }, [])

  const openPreview = useCallback((nextPreview: MediaPreviewItem) => {
    setPreview(nextPreview)
  }, [])

  return {
    closePreview,
    openPreview,
    preview,
  }
}
