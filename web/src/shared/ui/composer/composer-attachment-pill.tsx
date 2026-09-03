/**
 * 编辑器里的附件 pill：芯片内容与它的悬停预览卡（照 kimi 的 attachment-pill + mention-tip）。
 *
 * pill 的外层 span 是 PM NodeView 的 dom（落位与选中态由编辑器管），本组件经 portal 往里
 * 渲染芯片内容；上传失败给外层 span 加 `attachment-error`（kimi 的同名 class）。删除不走
 * 按钮：pill 是 atom 节点，点选后按退格整颗删掉（kimi 的内联 pill 本来就没有 ×）。
 *
 * 上传条目在这里翻译成「一份媒体的描述」——芯片与卡是与气泡共用的，不认 composer 的类型。
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import {
  MediaChipContent,
  type MediaDescriptor,
  MediaPreviewCard,
  type MediaUploadState,
  useHoverPreview,
} from '@/shared/ui/media-preview'
import type { ComposerAttachment, ComposerAttachmentKind } from './use-composer-attachments'

type ComposerAttachmentPillProps = {
  /** NodeView 外层 span（portal 目标，也是悬停卡锚点）。 */
  hostEl: HTMLElement
  kind: ComposerAttachmentKind
  name: string
  /** entry 表里的实时状态；还没登记上（首帧）时 undefined。 */
  entry: ComposerAttachment | undefined
}

const uploadStateOf = (entry: ComposerAttachment): MediaUploadState => {
  if (entry.status === 'uploading') return { progress: entry.progress, status: 'uploading' }
  if (entry.status === 'ready') return { status: 'ready' }
  return { message: entry.error ?? '上传失败——删除该附件，或重新拖入文件重试', status: 'error' }
}

/**
 * 渲染一颗附件 pill 的内容与悬停卡。
 *
 * @param props - 组件属性。
 * @returns pill 内容（portal 进 NodeView 的 dom）。
 */
export function ComposerAttachmentPill({ entry, hostEl, kind, name }: ComposerAttachmentPillProps) {
  const [viewing, setViewing] = useState(false)
  const tip = useHoverPreview()
  const { onEnter, onLeave } = tip

  // 上传失败：外层 span 变色（kimi 的 .attachment-pill.attachment-error）
  useEffect(() => {
    hostEl.classList.toggle('attachment-error', entry?.status === 'error')
    return () => hostEl.classList.remove('attachment-error')
  }, [hostEl, entry?.status])

  // 锚点是编辑器的 span，挂原生监听器；进卡不关由卡片那边接力同一对回调
  useEffect(() => {
    hostEl.addEventListener('mouseenter', onEnter)
    hostEl.addEventListener('mouseleave', onLeave)
    return () => {
      hostEl.removeEventListener('mouseenter', onEnter)
      hostEl.removeEventListener('mouseleave', onLeave)
    }
  }, [hostEl, onEnter, onLeave])

  const media: MediaDescriptor = {
    kind,
    name,
    previewUrl: entry?.previewUrl,
    size: entry?.size,
    upload: entry === undefined ? undefined : uploadStateOf(entry),
  }

  return (
    <>
      <MediaChipContent media={media} />
      {/* 灯箱开着的时候卡不再出现；entry 还没登记上时也没什么可看的 */}
      {tip.open && !viewing && entry !== undefined ? (
        <MediaPreviewCard
          anchorEl={hostEl}
          media={media}
          onEnter={onEnter}
          onLeave={onLeave}
          onOpenFullscreen={() => {
            tip.close()
            setViewing(true)
          }}
        />
      ) : null}
      {viewing && media.previewUrl !== undefined
        ? // 灯箱提到 body 下渲染，避开 contenteditable 里的继承样式
          createPortal(
            <MediaLightbox
              media={{
                kind: kind === 'video' ? 'video' : 'image',
                name,
                url: media.previewUrl,
              }}
              onClose={() => setViewing(false)}
            />,
            document.body,
          )
        : null}
    </>
  )
}
