/** 参考 Kimi mention-tip；锚点与卡共用悬停时序，hover 桥覆盖二者间隙。 */

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { ellipsizeAttachmentName, formatAttachmentSize } from './attachment-format'
import { MEDIA_KIND_ICON, type MediaDescriptor, mediaDisplayName } from './media-descriptor'

/** 卡与锚点间距，同时作为 hover 桥高度。 */
const TIP_GAP_PX = 6
/** 视口边距参考 Kimi --p-mention-tip-vmargin。 */
const TIP_VIEWPORT_MARGIN_PX = 12
/** 300px 预览区使用两倍分辨率 poster。 */
const POSTER_WIDTH_PX = 600
/** 进度环尺寸参考 Kimi mention-tip-media-ring。 */
const RING_RADIUS = 6.5
const RING_LENGTH = 40.84

type TipPlacement = {
  left: number
  top: number
  side: 'bottom' | 'top'
  caretX: number
}

type MediaPreviewCardProps = {
  anchorEl: HTMLElement
  media: MediaDescriptor
  onEnter: () => void
  onLeave: () => void
  onOpenFullscreen: () => void
}

export function MediaPreviewCard({
  anchorEl,
  media,
  onEnter,
  onLeave,
  onOpenFullscreen,
}: MediaPreviewCardProps) {
  // 隐藏状态下测量后定位；挂载与媒体加载回调负责重新测量。
  const [placement, setPlacement] = useState<TipPlacement | null>(null)
  const tipElRef = useRef<HTMLDivElement | null>(null)
  const tipRef = (el: HTMLDivElement | null) => {
    tipElRef.current = el
    measure(el)
  }

  const measure = (tip: HTMLDivElement | null) => {
    if (tip === null) return
    const anchor = anchorEl.getBoundingClientRect()
    const rect = tip.getBoundingClientRect()
    const anchorCenterX = anchor.left + anchor.width / 2
    const left = Math.min(
      Math.max(anchorCenterX - rect.width / 2, TIP_VIEWPORT_MARGIN_PX),
      window.innerWidth - rect.width - TIP_VIEWPORT_MARGIN_PX,
    )
    const side = anchor.top >= rect.height + TIP_GAP_PX + TIP_VIEWPORT_MARGIN_PX ? 'top' : 'bottom'
    const next: TipPlacement = {
      caretX: Math.min(Math.max(anchorCenterX - left, 12), rect.width - 12),
      left,
      side,
      top: side === 'top' ? anchor.top - rect.height - TIP_GAP_PX : anchor.bottom + TIP_GAP_PX,
    }
    setPlacement((prev) =>
      prev !== null &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.side === next.side &&
      prev.caretX === next.caretX
        ? prev
        : next,
    )
  }

  const name = mediaDisplayName(media)
  const isMedia = media.kind !== 'file'
  const { previewUrl, upload } = media
  const canOpenFullscreen = isMedia && previewUrl !== undefined
  const meta = (
    <div className="flex min-w-0 items-center gap-1">
      <Icon
        className="media-tip-ink shrink-0"
        decorative
        name={MEDIA_KIND_ICON[media.kind]}
        size="sm"
      />
      <span className="min-w-0 truncate font-semibold">{ellipsizeAttachmentName(name)}</span>
      {media.size === undefined ? null : (
        <span className="media-tip-ink shrink-0">· {formatAttachmentSize(media.size)}</span>
      )}
    </div>
  )

  return createPortal(
    <div
      className={cn(
        'media-tip layer-popup fixed max-w-[min(320px,100vw-24px)] rounded-sm bg-inverse-surface text-body-sm text-inverse-on-surface',
        isMedia && 'media-tip-media-card rounded-md',
        placement === null ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      ref={tipRef}
      role="tooltip"
      style={
        placement === null ? { left: 0, top: 0 } : { left: placement.left, top: placement.top }
      }
    >
      {isMedia ? (
        <div className="flex flex-col gap-1.5">
          <div className="media-tip-preview">
            {previewUrl === undefined ? (
              <div className="media-tip-hint">
                <Icon decorative name={MEDIA_KIND_ICON[media.kind]} size="lg" />
                <span>预览不可用</span>
              </div>
            ) : media.kind === 'image' ? (
              <img
                alt={name}
                className="block max-h-[220px] max-w-[300px] rounded-sm object-contain"
                onLoad={() => measure(tipElRef.current)}
                src={previewUrl}
              />
            ) : (
              // 仅展示静音首帧，不提供播放控件。
              <video
                aria-label={name}
                className="block max-h-[220px] max-w-[300px] rounded-sm object-contain"
                muted
                onLoadedMetadata={() => measure(tipElRef.current)}
                playsInline
                poster={videoSnapshotUrl(previewUrl, POSTER_WIDTH_PX)}
                preload="metadata"
                src={previewUrl}
              />
            )}
          </div>
          {meta}
        </div>
      ) : (
        meta
      )}
      {upload?.status === 'error' ? <div className="media-tip-error">{upload.message}</div> : null}
      {upload === undefined && !canOpenFullscreen ? null : (
        <div className="flex min-w-0 items-center gap-2">
          {upload === undefined ? null : (
            <span
              className={cn(
                'media-tip-ink flex min-w-0 flex-1 items-center gap-1.5 truncate pl-0.5 font-medium',
                upload.status === 'error' && 'media-tip-danger',
              )}
            >
              {upload.status === 'uploading' ? (
                <>
                  {upload.progress === undefined ? (
                    <Icon className="animate-spin" decorative name="loading" size="xs" />
                  ) : (
                    <svg aria-hidden className="size-3 shrink-0" viewBox="0 0 16 16">
                      <circle
                        cx="8"
                        cy="8"
                        fill="none"
                        r={RING_RADIUS}
                        strokeWidth="1.5"
                        style={{ stroke: 'color-mix(in srgb, currentColor 18%, transparent)' }}
                      />
                      <circle
                        cx="8"
                        cy="8"
                        fill="none"
                        r={RING_RADIUS}
                        stroke="currentColor"
                        strokeDasharray={`${(upload.progress * RING_LENGTH).toFixed(1)} ${RING_LENGTH}`}
                        strokeLinecap="round"
                        strokeWidth="1.5"
                        transform="rotate(-90 8 8)"
                      />
                    </svg>
                  )}
                  {upload.progress === undefined
                    ? '上传中'
                    : `上传中 ${Math.round(upload.progress * 100)}%`}
                </>
              ) : null}
              {upload.status === 'ready' ? '已上传' : null}
              {upload.status === 'error' ? '上传失败' : null}
            </span>
          )}
          {canOpenFullscreen ? (
            <button
              className="media-tip-open ml-auto flex-none"
              onClick={onOpenFullscreen}
              type="button"
            >
              <Icon decorative name="zoom" size="sm" />
              全屏查看
            </button>
          ) : null}
        </div>
      )}
      {placement === null ? null : (
        <span
          aria-hidden
          className={cn(
            'media-tip-caret',
            placement.side === 'top' ? 'media-tip-caret-down' : 'media-tip-caret-up',
          )}
          style={{ left: placement.caretX }}
        />
      )}
    </div>,
    document.body,
  )
}
