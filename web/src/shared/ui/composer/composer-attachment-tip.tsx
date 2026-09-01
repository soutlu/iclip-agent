/**
 * 附件 pill 的悬停卡（照 kimi 网页版的 mention-tip）。
 *
 * 反色小卡（inverse-surface 底 + inverse-on-surface 字）：图/视频给 ≤300×220 的预览
 * （棋盘格兜底透明底），下面一行类型图标 + 名字 + 大小，再下面是状态行（上传中 N% 进度环 /
 * 已上传 / 上传失败）与「全屏查看 / 新页打开」。出现 150ms 延迟、消失 120ms 延迟，光标在
 * pill 与卡之间往返不关（hover 桥由调用方的两个回调接力）。
 *
 * 视频不内嵌 <video>（没有字幕轨过不了 a11y，与 attachment-pills 的处理一致）——预览区
 * 画占位图标，查看走新页。
 */

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { ComposerAttachment } from './use-composer-attachments'
import { ellipsizeAttachmentName, formatAttachmentSize } from './attachment-format'

/** 卡与 pill 之间的空隙（kimi 的 hover 桥高度也是它）。 */
const TIP_GAP_PX = 6
/** 卡离视口边的最小距离（kimi --p-mention-tip-vmargin）。 */
const TIP_VIEWPORT_MARGIN_PX = 12
/** 进度环：半径 6.5、周长 40.84（kimi mention-tip-media-ring 的原值）。 */
const RING_RADIUS = 6.5
const RING_LENGTH = 40.84

const KIND_ICON: Record<ComposerAttachment['kind'], IconName> = {
  file: 'file',
  image: 'image',
  video: 'video',
}
const KIND_FALLBACK_NAME: Record<ComposerAttachment['kind'], string> = {
  file: '附件',
  image: '图片',
  video: '视频',
}

type TipPlacement = {
  left: number
  top: number
  side: 'bottom' | 'top'
  /** 小三角相对卡左缘的位置。 */
  caretX: number
}

type ComposerAttachmentTipProps = {
  /** 锚点 pill 元素。 */
  anchorEl: HTMLElement
  entry: ComposerAttachment
  /** 光标进卡：取消关闭计时。 */
  onHoverStart: () => void
  /** 光标出卡：开始关闭计时。 */
  onHoverEnd: () => void
  /** 图片的「全屏查看」。 */
  onOpenFullscreen: () => void
}

/**
 * 渲染附件悬停卡。
 *
 * @param props - 组件属性。
 * @returns portal 到 body 的悬停卡。
 */
export function ComposerAttachmentTip({
  anchorEl,
  entry,
  onHoverEnd,
  onHoverStart,
  onOpenFullscreen,
}: ComposerAttachmentTipProps) {
  // 先隐身渲染量出尺寸再定位（kimi：未定位时 pointer-events 关闭、opacity 0）。
  // 量尺寸发生在 ref 回调（挂载）与事件回调（图片载入）里，不经 effect。
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

  const name = entry.name === '' ? KIND_FALLBACK_NAME[entry.kind] : entry.name
  const isMedia = entry.kind !== 'file'

  return createPortal(
    <div
      className={cn(
        'composer-tip layer-popup fixed max-w-[min(320px,100vw-24px)] rounded-sm bg-inverse-surface text-body-sm text-inverse-on-surface',
        isMedia && 'composer-tip-media-card rounded-md',
        placement === null ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      ref={tipRef}
      role="tooltip"
      style={
        placement === null ? { left: 0, top: 0 } : { left: placement.left, top: placement.top }
      }
    >
      {isMedia ? (
        <div className="flex flex-col gap-1.5">
          <div className="composer-tip-preview">
            {entry.previewUrl !== undefined && entry.kind === 'image' ? (
              <img
                alt={name}
                className="block max-h-[220px] max-w-[300px] rounded-xs object-contain"
                onLoad={() => measure(tipElRef.current)}
                src={entry.previewUrl}
              />
            ) : (
              <div className="composer-tip-hint">
                <Icon decorative name={KIND_ICON[entry.kind]} size="lg" />
                <span>预览不可用</span>
              </div>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <Icon
              className="composer-tip-ink shrink-0"
              decorative
              name={KIND_ICON[entry.kind]}
              size="sm"
            />
            <span className="min-w-0 truncate font-semibold">{ellipsizeAttachmentName(name)}</span>
            <span className="composer-tip-ink shrink-0">· {formatAttachmentSize(entry.size)}</span>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <Icon
            className="composer-tip-ink shrink-0"
            decorative
            name={KIND_ICON[entry.kind]}
            size="sm"
          />
          <span className="min-w-0 truncate font-semibold">{ellipsizeAttachmentName(name)}</span>
          <span className="composer-tip-ink shrink-0">· {formatAttachmentSize(entry.size)}</span>
        </div>
      )}
      {entry.status === 'error' ? (
        <div className="composer-tip-error">
          {entry.error ?? '上传失败——删除该附件，或重新拖入文件重试'}
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'composer-tip-ink flex min-w-0 flex-1 items-center gap-1.5 truncate pl-0.5 font-medium',
            entry.status === 'error' && 'composer-tip-danger',
          )}
        >
          {entry.status === 'uploading' ? (
            <>
              {entry.progress === undefined ? (
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
                    strokeDasharray={`${(entry.progress * RING_LENGTH).toFixed(1)} ${RING_LENGTH}`}
                    strokeLinecap="round"
                    strokeWidth="1.5"
                    transform="rotate(-90 8 8)"
                  />
                </svg>
              )}
              {entry.progress === undefined
                ? '上传中'
                : `上传中 ${Math.round(entry.progress * 100)}%`}
            </>
          ) : null}
          {entry.status === 'ready' ? '已上传' : null}
          {entry.status === 'error' ? '上传失败' : null}
        </span>
        {entry.previewUrl !== undefined ? (
          <button
            className="composer-tip-open"
            onClick={() => {
              if (entry.kind === 'image') onOpenFullscreen()
              else window.open(entry.previewUrl, '_blank', 'noreferrer')
            }}
            type="button"
          >
            <Icon decorative name={entry.kind === 'image' ? 'zoom' : 'external'} size="sm" />
            {entry.kind === 'image' ? '全屏查看' : '新页打开'}
          </button>
        ) : null}
      </div>
      {placement === null ? null : (
        <span
          aria-hidden
          className={cn(
            'composer-tip-caret',
            placement.side === 'top' ? 'composer-tip-caret-down' : 'composer-tip-caret-up',
          )}
          style={{ left: placement.caretX }}
        />
      )}
    </div>,
    document.body,
  )
}
