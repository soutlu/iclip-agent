/**
 * 媒体的悬停预览卡（照 kimi 网页版的 mention-tip）。
 *
 * 反色小卡（inverse-surface 底 + inverse-on-surface 字）：图与视频给 ≤300×220 的预览
 * （棋盘格兜底透明底），下面一行类型图标 + 名字 + 大小，带上传状态的再多一行状态（上传中 N%
 * 进度环 / 已上传 / 上传失败）与「全屏查看」。
 *
 * 出没时序不在这里，由调用方的 useHoverPreview 给：光标在锚点与卡之间往返靠 onEnter /
 * onLeave 接力，卡与锚点之间那 6px 空隙由 hover 桥兜着。
 */

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { ellipsizeAttachmentName, formatAttachmentSize } from './attachment-format'
import { MEDIA_KIND_ICON, type MediaDescriptor, mediaDisplayName } from './media-descriptor'

/** 卡与锚点之间的空隙（kimi 的 hover 桥高度也是它）。 */
const TIP_GAP_PX = 6
/** 卡离视口边的最小距离（kimi --p-mention-tip-vmargin）。 */
const TIP_VIEWPORT_MARGIN_PX = 12
/** 预览区最大 300 宽，poster 按 2 倍屏要图。 */
const POSTER_WIDTH_PX = 600
/** 进度环：半径 6.5、周长 40.84（kimi mention-tip-media-ring 的原值）。 */
const RING_RADIUS = 6.5
const RING_LENGTH = 40.84

type TipPlacement = {
  left: number
  top: number
  side: 'bottom' | 'top'
  /** 小三角相对卡左缘的位置。 */
  caretX: number
}

type MediaPreviewCardProps = {
  /** 锚点元素（芯片本体）。 */
  anchorEl: HTMLElement
  media: MediaDescriptor
  /** 光标进卡。 */
  onEnter: () => void
  /** 光标出卡。 */
  onLeave: () => void
  /** 点了「全屏查看」。 */
  onOpenFullscreen: () => void
}

/**
 * 渲染媒体悬停卡。
 *
 * @param props - 组件属性。
 * @returns portal 到 body 的悬停卡。
 */
export function MediaPreviewCard({
  anchorEl,
  media,
  onEnter,
  onLeave,
  onOpenFullscreen,
}: MediaPreviewCardProps) {
  // 先隐身渲染量出尺寸再定位（kimi：未定位时 pointer-events 关闭、opacity 0）。
  // 量尺寸发生在 ref 回调（挂载）与事件回调（图片载入、视频读到元数据）里，不经 effect。
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
    // 尺寸没变就不写状态
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
                className="block max-h-[220px] max-w-[300px] rounded-xs object-contain"
                onLoad={() => measure(tipElRef.current)}
                src={previewUrl}
              />
            ) : (
              // 只当首帧看：静音、不给控件，也就不需要字幕轨（用户自己传的素材本来没有）
              <video
                aria-label={name}
                className="block max-h-[220px] max-w-[300px] rounded-xs object-contain"
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
            <button className="media-tip-open" onClick={onOpenFullscreen} type="button">
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
