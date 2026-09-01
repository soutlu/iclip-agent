/**
 * 编辑器里的附件 pill 与它的悬停卡（照 kimi 的 attachment-pill + mention-tip 控制器）。
 *
 * pill 的外层 span 是 PM NodeView 的 dom（落位与选中态由编辑器管），本组件经 portal 往里
 * 渲染图标与名字；上传失败给外层 span 加 `attachment-error`（kimi 的同名 class）。删除不走
 * 按钮：pill 是 atom 节点，点选后按退格整颗删掉（kimi 的内联 pill 本来就没有 ×）。
 *
 * 悬停卡时序照 kimi：冷启动 150ms 出现、离开 120ms 后关闭；刚关过一张就移动到下颗 pill
 * 立即出现（400ms 内算「还在看」）；光标移进卡里不关。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@/shared/icons'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { ComposerAttachmentTip } from './composer-attachment-tip'
import type { ComposerAttachment, ComposerAttachmentKind } from './use-composer-attachments'
import { ellipsizeAttachmentName } from './attachment-format'

const KIND_ICON: Record<ComposerAttachmentKind, IconName> = {
  file: 'file',
  image: 'image',
  video: 'video',
}

/** 悬停卡出现时序（kimi --duration-tooltip / --duration-fast）。 */
const TIP_OPEN_DELAY_MS = 150
const TIP_CLOSE_DELAY_MS = 120
/** 两张卡之间移动免延迟的窗口。 */
const TIP_WARM_REOPEN_MS = 400

/** 全局只有一张悬停卡：最近一张关闭的时刻，用来判 pill 间游走要不要免延迟。 */
let lastTipClosedAt = 0

type ComposerAttachmentPillProps = {
  /** NodeView 外层 span（portal 目标，也是悬停卡锚点）。 */
  hostEl: HTMLElement
  attId: string
  kind: ComposerAttachmentKind
  name: string
  /** entry 表里的实时状态；还没登记上（首帧）时 undefined。 */
  entry: ComposerAttachment | undefined
}

/**
 * 渲染一颗附件 pill 的内容与悬停卡。
 *
 * @param props - 组件属性。
 * @returns pill 内容（portal 进 NodeView 的 dom）。
 */
export function ComposerAttachmentPill({
  attId,
  entry,
  hostEl,
  kind,
  name,
}: ComposerAttachmentPillProps) {
  const [tipOpen, setTipOpen] = useState(false)
  const [viewing, setViewing] = useState(false)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 上传失败：外层 span 变色（kimi 的 .attachment-pill.attachment-error）
  useEffect(() => {
    hostEl.classList.toggle('attachment-error', entry?.status === 'error')
    return () => hostEl.classList.remove('attachment-error')
  }, [hostEl, entry?.status])

  useEffect(() => {
    const clearTimers = () => {
      if (openTimerRef.current !== null) clearTimeout(openTimerRef.current)
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
      openTimerRef.current = null
      closeTimerRef.current = null
    }
    const open = () => {
      clearTimers()
      const cold = Date.now() - lastTipClosedAt >= TIP_WARM_REOPEN_MS
      openTimerRef.current = setTimeout(() => setTipOpen(true), cold ? TIP_OPEN_DELAY_MS : 0)
    }
    const scheduleClose = () => {
      clearTimers()
      closeTimerRef.current = setTimeout(() => {
        lastTipClosedAt = Date.now()
        setTipOpen(false)
      }, TIP_CLOSE_DELAY_MS)
    }
    hostEl.addEventListener('mouseenter', open)
    hostEl.addEventListener('mouseleave', scheduleClose)
    return () => {
      clearTimers()
      hostEl.removeEventListener('mouseenter', open)
      hostEl.removeEventListener('mouseleave', scheduleClose)
    }
  }, [hostEl])

  // 灯箱开着的时候悬停卡不再出现
  const tipEntry = tipOpen && !viewing && entry !== undefined ? entry : null

  return (
    <>
      <span className="attachment-pill-icon">
        <Icon decorative name={KIND_ICON[kind]} size="sm" />
      </span>
      <span className="attachment-pill-name">{ellipsizeAttachmentName(name)}</span>
      {tipEntry === null ? null : (
        <ComposerAttachmentTip
          anchorEl={hostEl}
          entry={tipEntry}
          onHoverEnd={() => {
            if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
            closeTimerRef.current = setTimeout(() => {
              lastTipClosedAt = Date.now()
              setTipOpen(false)
            }, TIP_CLOSE_DELAY_MS)
          }}
          onHoverStart={() => {
            if (openTimerRef.current !== null) clearTimeout(openTimerRef.current)
            if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
            openTimerRef.current = null
            closeTimerRef.current = null
          }}
          onOpenFullscreen={() => {
            lastTipClosedAt = Date.now()
            setTipOpen(false)
            setViewing(true)
          }}
        />
      )}
      {viewing && entry?.previewUrl !== undefined
        ? // 灯箱提到 body 下渲染，避开 contenteditable 里的继承样式
          createPortal(
            <MediaLightbox
              attachment={{
                attachmentId: attId,
                mediaType: entry.mediaType,
                name,
                size: entry.size,
                source: { kind: 'url', url: entry.previewUrl },
              }}
              onClose={() => setViewing(false)}
            />,
            document.body,
          )
        : null}
    </>
  )
}
