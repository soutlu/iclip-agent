import { useEffect, useState } from 'react'
import type { StoryboardFrameImageEntry } from '@/features/artifacts/renderers/storyboard/storyboard-frame-image.types'
import {
  getDisplayValue,
  getStoryboardRowLabel,
  getStoryboardVideoLabel,
  getStructureLevelStyle,
  hasText,
  type StoryboardPalette,
  type StoryboardTableColumn,
  TABLE_BODY_CELL_CLASS,
} from '@/features/artifacts/renderers/storyboard/storyboard-table-config'
import useViewportActivation from '@/features/artifacts/renderers/storyboard/useViewportActivation'
import type { StoryboardShot } from '@/features/artifacts/types/storyboard.types'

interface StoryboardFrameCellProps {
  onPreviewOpen: (image: StoryboardFrameImageEntry, shot: StoryboardShot) => void
  palette: StoryboardPalette
  shot: StoryboardShot
}

interface StoryboardFrameThumbnailProps {
  image: StoryboardFrameImageEntry
  onPreviewOpen: (image: StoryboardFrameImageEntry, shot: StoryboardShot) => void
  palette: StoryboardPalette
  shot: StoryboardShot
}

interface StoryboardRowBodyCellProps {
  palette: StoryboardPalette
  shot: StoryboardShot
}

interface StoryboardShotRowProps {
  columns: StoryboardTableColumn[]
  onImagePreviewOpen: (image: StoryboardFrameImageEntry, shot: StoryboardShot) => void
  onVideoPreviewOpen: (shot: StoryboardShot) => void
  palette: StoryboardPalette
  shot: StoryboardShot
}

interface StoryboardShotCellContentProps {
  column: StoryboardTableColumn
  onImagePreviewOpen: (image: StoryboardFrameImageEntry, shot: StoryboardShot) => void
  onVideoPreviewOpen: (shot: StoryboardShot) => void
  palette: StoryboardPalette
  shot: StoryboardShot
}

interface StoryboardVideoCellProps {
  onPreviewOpen: (shot: StoryboardShot) => void
  palette: StoryboardPalette
  shot: StoryboardShot
}

interface StoryboardVideoPromptCellProps {
  palette: StoryboardPalette
  shot: StoryboardShot
}

interface StoryboardVideoThumbnailProps {
  onPreviewOpen: (shot: StoryboardShot) => void
  palette: StoryboardPalette
  shot: StoryboardShot
}

const DEFAULT_VIDEO_ASPECT_RATIO = 9 / 16

const toCssBackgroundImage = (url: string) => `url(${JSON.stringify(url)})`

const buildStoryboardFrameImageEntries = (shot: StoryboardShot): StoryboardFrameImageEntry[] => {
  const imageUrls = shot.imageUrls ?? []
  const occurrenceByUrl = new Map<string, number>()

  return imageUrls.flatMap((url, imageIndex) => {
    if (!hasText(url)) {
      return []
    }

    const occurrence = (occurrenceByUrl.get(url) ?? 0) + 1
    occurrenceByUrl.set(url, occurrence)
    const imageOrder = imageIndex + 1
    const shotLabel = getStoryboardRowLabel(shot)

    return [
      {
        alt: `${shotLabel} 第 ${imageOrder} 帧分镜图`,
        key: `${url}::${occurrence}`,
        orderLabel: `第 ${imageOrder} 帧`,
        url,
      },
    ]
  })
}

function StoryboardErrorStatusIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>错误状态</title>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 9L15 15" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M15 9L9 15" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

function StoryboardPlayStatusIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>播放</title>
      <circle cx="12" cy="12" fill="currentColor" opacity="0.18" r="10" />
      <path d="M10 8.5L16 12L10 15.5V8.5Z" fill="currentColor" />
    </svg>
  )
}

function StoryboardFrameThumbnail({
  image,
  onPreviewOpen,
  palette,
  shot,
}: StoryboardFrameThumbnailProps) {
  const [aspectRatio, setAspectRatio] = useState(1)

  useEffect(() => {
    let cancelled = false
    const frameImage = new globalThis.Image()
    frameImage.decoding = 'async'

    frameImage.onload = () => {
      if (cancelled || frameImage.naturalHeight <= 0) {
        return
      }

      setAspectRatio(frameImage.naturalWidth / frameImage.naturalHeight)
    }

    frameImage.onerror = () => {
      if (!cancelled) {
        setAspectRatio(1)
      }
    }

    frameImage.src = image.url

    return () => {
      cancelled = true
    }
  }, [image.url])

  const normalizedAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1

  return (
    <button
      aria-label={`查看${image.alt}`}
      className="nodrag nopan group relative block h-[264px] shrink-0 cursor-pointer overflow-hidden rounded-xl border p-0 text-left transition-transform ui-motion-m hover:scale-[1.01] focus-visible:ring-2"
      onDoubleClick={() => onPreviewOpen(image, shot)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }

        event.preventDefault()
        onPreviewOpen(image, shot)
      }}
      style={{
        ['--tw-ring-color' as string]: palette.accent,
        aspectRatio: normalizedAspectRatio,
        backgroundColor: palette.background,
        borderColor: palette.badgeBorder,
      }}
      title="双击查看大图"
      type="button"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-contain bg-center bg-no-repeat transition-transform ui-motion-m group-hover:scale-[1.01]"
        style={{ backgroundImage: toCssBackgroundImage(image.url) }}
      />
      <span className="pointer-events-none absolute top-3 left-3 rounded-full border border-white/20 bg-black/28 px-2.5 py-1 text-caption font-semibold text-white/92 backdrop-blur-sm">
        {image.orderLabel}
      </span>
    </button>
  )
}

function StoryboardFrameCell({ onPreviewOpen, palette, shot }: StoryboardFrameCellProps) {
  const imageEntries = buildStoryboardFrameImageEntries(shot)

  if (imageEntries.length === 0) {
    return null
  }

  return (
    <div
      className="nodrag nopan nowheel flex cursor-auto gap-3 overflow-x-auto pb-1"
      data-scrollable
    >
      {imageEntries.map((image) => (
        <StoryboardFrameThumbnail
          key={image.key}
          image={image}
          onPreviewOpen={onPreviewOpen}
          palette={palette}
          shot={shot}
        />
      ))}
    </div>
  )
}

function StoryboardVideoThumbnail({ onPreviewOpen, palette, shot }: StoryboardVideoThumbnailProps) {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_VIDEO_ASPECT_RATIO)
  const [videoReady, setVideoReady] = useState(false)
  const { activate, hasActivated, ref } = useViewportActivation<HTMLButtonElement>({
    enabled: hasText(shot.videoUrl),
  })

  if (shot.videoStatus !== 'succeeded' || !hasText(shot.videoUrl)) {
    return null
  }

  const normalizedAspectRatio =
    Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : DEFAULT_VIDEO_ASPECT_RATIO
  const videoLabel = getStoryboardVideoLabel(shot)

  return (
    <button
      ref={ref}
      aria-label={`播放${videoLabel}`}
      className="nodrag nopan group relative block h-[264px] shrink-0 cursor-pointer overflow-hidden rounded-xl border p-0 text-left transition-transform ui-motion-m hover:scale-[1.01] focus-visible:ring-2"
      onDoubleClick={() => {
        activate()
        onPreviewOpen(shot)
      }}
      onFocus={activate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }

        event.preventDefault()
        activate()
        onPreviewOpen(shot)
      }}
      onPointerEnter={activate}
      style={{
        ['--tw-ring-color' as string]: palette.accent,
        aspectRatio: normalizedAspectRatio,
        backgroundColor: palette.background,
        borderColor: palette.badgeBorder,
      }}
      title="双击播放视频"
      type="button"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 transition-opacity ui-motion-m"
        style={{
          background: `linear-gradient(150deg, ${palette.surface} 0%, ${palette.background} 100%)`,
          opacity: videoReady ? 0 : 1,
        }}
      />

      {hasActivated ? (
        <>
          <video
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-contain transition-opacity ui-motion-m"
            muted
            onLoadedData={() => setVideoReady(true)}
            onLoadedMetadata={(event) => {
              const { videoHeight, videoWidth } = event.currentTarget

              if (videoHeight > 0) {
                setAspectRatio(videoWidth / videoHeight)
              }
            }}
            playsInline
            preload="metadata"
            src={shot.videoUrl}
            style={{ opacity: videoReady ? 1 : 0 }}
            tabIndex={-1}
          >
            当前环境不支持视频预览。
          </video>
          <div
            aria-hidden="true"
            className="absolute inset-0 transition-opacity ui-motion-m"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--color-sb-table-text) 8%, transparent) 0%, color-mix(in srgb, var(--color-sb-table-text) 14%, transparent) 52%, color-mix(in srgb, var(--color-sb-table-text) 46%, transparent) 100%)',
              opacity: videoReady ? 1 : 0.72,
            }}
          />
        </>
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 transition-opacity ui-motion-m"
          style={{
            background:
              'linear-gradient(180deg, color-mix(in srgb, var(--color-sb-table-text) 2%, transparent) 0%, color-mix(in srgb, var(--color-sb-table-text) 8%, transparent) 56%, color-mix(in srgb, var(--color-sb-table-text) 22%, transparent) 100%)',
          }}
        />
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4">
        <div className="min-w-0 space-y-2">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/28 text-white/92 backdrop-blur-sm">
            <StoryboardPlayStatusIcon />
          </span>
          <div className="space-y-1">
            <p className="truncate text-label font-semibold tracking-[0.16em] text-white/92 uppercase">
              最终视频
            </p>
            {hasText(shot.videoTaskId) ? (
              <p className="truncate font-mono text-caption text-white/72">{shot.videoTaskId}</p>
            ) : null}
          </div>
        </div>

        {hasText(shot.structureLevel) ? (
          <span className="rounded-full border border-white/20 bg-black/28 px-2.5 py-1 text-caption text-white/88 backdrop-blur-sm">
            {shot.structureLevel}
          </span>
        ) : null}
      </div>
    </button>
  )
}

function StoryboardVideoCell({ onPreviewOpen, palette, shot }: StoryboardVideoCellProps) {
  if (shot.videoStatus === 'failed') {
    return (
      <div
        className="canvas-fragment-enter rounded-xl border px-4 py-4 transition-all ui-motion-m"
        style={{
          backgroundColor: palette.dangerSoft,
          borderColor: 'color-mix(in srgb, var(--color-sb-table-danger) 18%, transparent)',
        }}
      >
        <div className="mb-3 flex items-center gap-2" style={{ color: palette.danger }}>
          <StoryboardErrorStatusIcon />
          <span className="text-body font-semibold tracking-[0]">视频生成失败</span>
        </div>
        <p
          className="text-body leading-[1.65] whitespace-pre-wrap"
          style={{ color: palette.danger }}
        >
          {getDisplayValue(shot.videoError, '最终视频生成失败')}
        </p>
        {hasText(shot.videoTaskId) ? (
          <p className="mt-3 font-mono text-label" style={{ color: palette.danger }}>
            {shot.videoTaskId}
          </p>
        ) : null}
      </div>
    )
  }

  if (shot.videoStatus === 'succeeded' && hasText(shot.videoUrl)) {
    return (
      <div
        className="canvas-fragment-enter nodrag nopan nowheel cursor-auto overflow-x-auto pb-1 transition-all ui-motion-m"
        data-scrollable
      >
        <StoryboardVideoThumbnail
          key={shot.videoUrl ?? shot.videoTaskId ?? shot.id ?? 'video'}
          onPreviewOpen={onPreviewOpen}
          palette={palette}
          shot={shot}
        />
      </div>
    )
  }

  return null
}

function StoryboardStorylineCell({ palette, shot }: StoryboardRowBodyCellProps) {
  if (shot.shotStatus === 'failed') {
    return (
      <div
        className="canvas-fragment-enter rounded-xl border px-4 py-4 transition-all ui-motion-m"
        style={{
          backgroundColor: palette.dangerSoft,
          borderColor: 'color-mix(in srgb, var(--color-sb-table-danger) 18%, transparent)',
        }}
      >
        <div className="mb-3 flex items-center gap-2" style={{ color: palette.danger }}>
          <StoryboardErrorStatusIcon />
          <span className="text-body font-semibold tracking-[0]">分镜结构化失败</span>
        </div>
        <p
          className="text-body leading-[1.65] whitespace-pre-wrap"
          style={{ color: palette.danger }}
        >
          {getDisplayValue(shot.error, '分镜结构化失败')}
        </p>
      </div>
    )
  }

  return (
    <p
      className="text-title leading-[1.65] whitespace-pre-wrap"
      data-storyboard-storyline-text="true"
      style={{ color: palette.textSecondary }}
    >
      {getDisplayValue(shot.storyline)}
    </p>
  )
}

function StoryboardVideoPromptCell({ palette, shot }: StoryboardVideoPromptCellProps) {
  if (shot.videoPromptStatus === 'failed') {
    return (
      <div
        className="canvas-fragment-enter rounded-xl border px-4 py-4 transition-all ui-motion-m"
        style={{
          backgroundColor: palette.dangerSoft,
          borderColor: 'color-mix(in srgb, var(--color-sb-table-danger) 18%, transparent)',
        }}
      >
        <div className="mb-3 flex items-center gap-2" style={{ color: palette.danger }}>
          <StoryboardErrorStatusIcon />
          <span className="text-body font-semibold tracking-[0]">生成失败</span>
        </div>
        <p
          className="text-body leading-[1.65] whitespace-pre-wrap"
          style={{ color: palette.danger }}
        >
          {getDisplayValue(shot.videoPromptError, 'Video Prompt 生成失败')}
        </p>
      </div>
    )
  }

  if (shot.videoPromptStatus === 'succeeded' && hasText(shot.videoPrompt)) {
    return (
      <div
        className="canvas-fragment-enter rounded-xl border px-4 py-4 transition-all ui-motion-m"
        style={{
          backgroundColor: palette.promptSurface,
          borderColor: palette.badgeBorder,
        }}
      >
        <p
          className="text-body leading-[1.7] break-words whitespace-pre-wrap"
          style={{ color: palette.textPrimary }}
        >
          {shot.videoPrompt}
        </p>
      </div>
    )
  }

  return null
}

function StoryboardShotIdCell({ palette, shot }: StoryboardRowBodyCellProps) {
  return (
    <div className="space-y-3">
      <span
        className="block text-headline-lg leading-none font-semibold tracking-[0]"
        style={{ color: palette.accent, opacity: 0.6 }}
      >
        {getDisplayValue(shot.id, '--')}
      </span>
      {shot.shotStatus === 'failed' ? (
        <span
          className="inline-flex rounded-full border px-3 py-1 text-label font-semibold tracking-[0.14em] uppercase"
          style={{
            backgroundColor: palette.dangerSoft,
            borderColor: 'color-mix(in srgb, var(--color-sb-table-danger) 18%, transparent)',
            color: palette.danger,
          }}
        >
          失败
        </span>
      ) : null}
    </div>
  )
}

function StoryboardStructureLevelCell({ palette, shot }: StoryboardRowBodyCellProps) {
  const structureLevelStyle = getStructureLevelStyle(palette, shot.structureLevel)

  return (
    <div className="space-y-4">
      <span
        className="inline-flex rounded-md border px-4 py-2.5 text-body font-semibold tracking-[0] uppercase"
        style={{ ...structureLevelStyle, borderColor: palette.badgeBorder }}
      >
        {getDisplayValue(shot.structureLevel)}
      </span>
      {hasText(shot.error) ? (
        <p
          className="text-body leading-[1.65] whitespace-pre-wrap"
          style={{ color: palette.danger }}
        >
          {shot.error}
        </p>
      ) : null}
    </div>
  )
}

function StoryboardShotCellContent({
  column,
  onImagePreviewOpen,
  onVideoPreviewOpen,
  palette,
  shot,
}: StoryboardShotCellContentProps) {
  switch (column.key) {
    case 'id':
      return <StoryboardShotIdCell palette={palette} shot={shot} />
    case 'structureLevel':
      return <StoryboardStructureLevelCell palette={palette} shot={shot} />
    case 'storyline':
      return <StoryboardStorylineCell palette={palette} shot={shot} />
    case 'frames':
      return (
        <StoryboardFrameCell onPreviewOpen={onImagePreviewOpen} palette={palette} shot={shot} />
      )
    case 'videoPrompt':
      return <StoryboardVideoPromptCell palette={palette} shot={shot} />
    case 'finalVideo':
      return (
        <StoryboardVideoCell onPreviewOpen={onVideoPreviewOpen} palette={palette} shot={shot} />
      )
    default: {
      const exhaustiveKey: never = column.key
      return exhaustiveKey
    }
  }
}

export function StoryboardShotRow({
  columns,
  onImagePreviewOpen,
  onVideoPreviewOpen,
  palette,
  shot,
}: StoryboardShotRowProps) {
  const cellStyle = { borderColor: palette.line }

  return (
    <tr className="canvas-fragment-enter align-top">
      {columns.map((column) => (
        <td className={TABLE_BODY_CELL_CLASS} key={column.key} style={cellStyle}>
          <StoryboardShotCellContent
            column={column}
            onImagePreviewOpen={onImagePreviewOpen}
            onVideoPreviewOpen={onVideoPreviewOpen}
            palette={palette}
            shot={shot}
          />
        </td>
      ))}
    </tr>
  )
}
