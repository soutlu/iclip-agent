import { Dialog } from 'radix-ui'
import type { SyntheticEvent, WheelEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import type { ImagePreviewMode, MediaPreviewItem } from '@/shared/ui/media/media-preview.types'
import {
  getNextImagePreviewScale,
  resolveImagePreviewFitScale,
  toggleImagePreviewMode,
} from '@/shared/ui/media/media-preview.utils'

interface MediaPreviewDialogProps {
  onClose: () => void
  preview: MediaPreviewItem
}

interface ImageViewportSize {
  height: number
  width: number
}

interface MediaNaturalSize {
  height: number
  width: number
}

const DEFAULT_VIEWPORT_SIZE: ImageViewportSize = { height: 900, width: 1440 }
const DEFAULT_IMAGE_RENDER_SIZE = 560
const MEDIA_PREVIEW_MAX_HEIGHT_OFFSET = 176
const MEDIA_PREVIEW_MAX_WIDTH = 1280
const MEDIA_PREVIEW_MIN_HEIGHT = 280
const MEDIA_PREVIEW_MIN_WIDTH = 280
const MEDIA_PREVIEW_VIEWPORT_PADDING = 96

const getViewportSize = (): ImageViewportSize => {
  if (typeof globalThis.window === 'undefined') {
    return DEFAULT_VIEWPORT_SIZE
  }

  return {
    height: globalThis.window.innerHeight,
    width: globalThis.window.innerWidth,
  }
}

const getMediaBounds = (viewportSize: ImageViewportSize) => ({
  maxHeight: Math.max(
    viewportSize.height - MEDIA_PREVIEW_MAX_HEIGHT_OFFSET,
    MEDIA_PREVIEW_MIN_HEIGHT,
  ),
  maxWidth: Math.max(
    Math.min(viewportSize.width - MEDIA_PREVIEW_VIEWPORT_PADDING, MEDIA_PREVIEW_MAX_WIDTH),
    MEDIA_PREVIEW_MIN_WIDTH,
  ),
})

export default function MediaPreviewDialog({ onClose, preview }: MediaPreviewDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [imageLoadError, setImageLoadError] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageMode, setImageMode] = useState<ImagePreviewMode>('fit')
  const [imageNaturalSize, setImageNaturalSize] = useState<MediaNaturalSize | null>(null)
  const [imageScale, setImageScale] = useState(1)
  const [viewportSize, setViewportSize] = useState<ImageViewportSize>(getViewportSize)
  const dialogLabel =
    preview.mediaType === 'audio'
      ? `${preview.fileName} 音频预览`
      : preview.mediaType === 'image'
        ? `${preview.fileName} 图片预览`
        : `${preview.fileName} 视频预览`

  useEffect(() => {
    const updateViewportSize = () => {
      setViewportSize(getViewportSize())
    }

    updateViewportSize()
    globalThis.window.addEventListener('resize', updateViewportSize)

    return () => {
      globalThis.window.removeEventListener('resize', updateViewportSize)
    }
  }, [])

  const mediaBounds = useMemo(() => getMediaBounds(viewportSize), [viewportSize])
  const imageRenderSize = useMemo(
    () =>
      imageNaturalSize ?? {
        height: Math.min(mediaBounds.maxHeight, DEFAULT_IMAGE_RENDER_SIZE),
        width: Math.min(mediaBounds.maxWidth, DEFAULT_IMAGE_RENDER_SIZE),
      },
    [imageNaturalSize, mediaBounds.maxHeight, mediaBounds.maxWidth],
  )

  const fitScale = useMemo(
    () =>
      resolveImagePreviewFitScale({
        imageHeight: imageRenderSize.height,
        imageWidth: imageRenderSize.width,
        viewportHeight: mediaBounds.maxHeight,
        viewportWidth: mediaBounds.maxWidth,
      }),
    [imageRenderSize.height, imageRenderSize.width, mediaBounds.maxHeight, mediaBounds.maxWidth],
  )

  const effectiveImageScale = imageMode === 'fit' ? fitScale : imageScale
  const imageDisplayHeight = Math.max(Math.round(imageRenderSize.height * effectiveImageScale), 1)
  const imageDisplayWidth = Math.max(Math.round(imageRenderSize.width * effectiveImageScale), 1)
  const imageIsReady = imageLoaded && !imageLoadError && imageNaturalSize !== null

  const handleImageClick = useCallback(() => {
    if (!imageIsReady) {
      return
    }

    setImageMode((currentMode) => {
      const nextMode = toggleImagePreviewMode(currentMode)

      if (nextMode === 'actual') {
        setImageScale(1)
      }

      return nextMode
    })
  }, [imageIsReady])

  const handleImageWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (preview.mediaType !== 'image' || !imageIsReady) {
        return
      }

      event.preventDefault()
      const baseScale = imageMode === 'fit' ? fitScale : imageScale
      setImageMode('actual')
      setImageScale(getNextImagePreviewScale(baseScale, event.deltaY))
    },
    [fitScale, imageIsReady, imageMode, imageScale, preview.mediaType],
  )

  const handleImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalHeight, naturalWidth } = event.currentTarget

    if (naturalHeight <= 0 || naturalWidth <= 0) {
      return
    }

    setImageLoadError(false)
    setImageLoaded(true)
    setImageNaturalSize({
      height: naturalHeight,
      width: naturalWidth,
    })
  }, [])

  const handleImageError = useCallback(() => {
    setImageLoadError(true)
    setImageLoaded(false)
    setImageNaturalSize(null)
  }, [])

  // modal Dialog：预览打开时它是最顶层 disableOutsidePointerEvents 层，遮罩与关闭按钮
  // 都放在 Dialog.Content 内部保证可交互；下层弹层（如 ERP 取图）不会把预览内的
  // pointerdown 误判为外点而连带关闭。
  return (
    <Dialog.Root
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          aria-label={dialogLabel}
          aria-modal="true"
          className="layer-popup fixed inset-0 flex items-center justify-center bg-transparent p-6"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            closeButtonRef.current?.focus()
          }}
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={onClose}
          />

          <button
            aria-label="关闭媒体预览"
            className="hit-48 layer-local-2 absolute top-6 right-6 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/18 text-white transition-colors hover:bg-black/28 active:scale-95"
            onClick={onClose}
            ref={closeButtonRef}
            title="关闭"
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="16"
              viewBox="0 0 24 24"
              width="16"
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>关闭</title>
              <line
                x1="18"
                x2="6"
                y1="6"
                y2="18"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2.4"
              />
              <line
                x1="6"
                x2="18"
                y1="6"
                y2="18"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2.4"
              />
            </svg>
          </button>

          <div className="layer-local-1 relative flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] flex-col bg-transparent">
            <div className="flex max-w-[calc(100vw-48px)] items-center justify-center overflow-visible">
              {preview.mediaType === 'audio' ? (
                <div className="flex min-w-[280px] flex-col gap-4 rounded-2xl bg-black/84 p-5 text-white shadow-[var(--shadow-3)]">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/12">
                      <svg
                        aria-hidden="true"
                        width="18"
                        height="18"
                        viewBox="0 0 256 256"
                        fill="currentColor"
                      >
                        <title>音频</title>
                        <path d="M210.3,56.8A8,8,0,0,0,203,56H96A16,16,0,0,0,80,72V168.4A31.8,31.8,0,0,0,64,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V112H200v56.4A31.8,31.8,0,0,0,184,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V64A8,8,0,0,0,210.3,56.8ZM96,96V72H200V96Z" />
                      </svg>
                    </span>
                    <span className="min-w-0 truncate text-sm font-medium">{preview.fileName}</span>
                  </div>
                  <audio
                    aria-label={dialogLabel}
                    autoPlay
                    className="w-full"
                    controls
                    preload="metadata"
                    src={preview.url}
                  />
                </div>
              ) : preview.mediaType === 'image' ? (
                <div
                  className="relative max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] overflow-auto rounded-2xl bg-transparent"
                  onWheel={handleImageWheel}
                >
                  {imageLoadError ? (
                    <div
                      className="flex items-center justify-center px-8 py-16 text-sm text-[var(--color-on-surface-variant)]"
                      style={{
                        minHeight: `${mediaBounds.maxHeight}px`,
                        minWidth: `${Math.min(mediaBounds.maxWidth, 560)}px`,
                      }}
                    >
                      图片预览加载失败。
                    </div>
                  ) : (
                    <button
                      aria-label={`${preview.fileName}，点击切换缩放模式`}
                      className={cn(
                        'relative block bg-transparent p-0 transition-opacity',
                        imageMode === 'fit' ? 'cursor-zoom-in' : 'cursor-zoom-out',
                      )}
                      onClick={handleImageClick}
                      title={imageMode === 'fit' ? '点击查看 100% 原始尺寸' : '点击恢复适配视口'}
                      type="button"
                    >
                      <img
                        alt={preview.altText ?? preview.fileName}
                        className="block select-none"
                        draggable={false}
                        height={imageRenderSize.height}
                        loading="eager"
                        onError={handleImageError}
                        onLoad={handleImageLoad}
                        src={preview.url}
                        style={{
                          height: `${imageDisplayHeight}px`,
                          maxWidth: 'none',
                          opacity: imageLoaded ? 1 : 0,
                          width: `${imageDisplayWidth}px`,
                        }}
                        width={imageRenderSize.width}
                      />
                      {!imageLoaded ? (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--color-on-surface-variant)]"
                        >
                          正在加载图片预览...
                        </span>
                      ) : null}
                    </button>
                  )}
                </div>
              ) : (
                <video
                  aria-label={dialogLabel}
                  autoPlay
                  className="block rounded-2xl bg-black"
                  controls
                  loop
                  playsInline
                  preload="metadata"
                  src={preview.url}
                  style={{
                    maxHeight: 'calc(100vh - 48px)',
                    maxWidth: 'calc(100vw - 48px)',
                    width: 'auto',
                  }}
                >
                  当前环境不支持视频预览。
                </video>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
