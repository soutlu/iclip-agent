/** 参考 Kimi attachment-pill：NodeView 管理外层与选中态，React portal 渲染共用媒体内容；删除由原子节点退格操作处理。 */

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
  hostEl: HTMLElement
  kind: ComposerAttachmentKind
  name: string
  /** 首帧尚未登记上传条目时为 undefined。 */
  entry: ComposerAttachment | undefined
}

const uploadStateOf = (entry: ComposerAttachment): MediaUploadState => {
  if (entry.status === 'uploading') return { progress: entry.progress, status: 'uploading' }
  if (entry.status === 'ready') return { status: 'ready' }
  return { message: entry.error ?? '上传失败——删除该附件，或重新拖入文件重试', status: 'error' }
}

export function ComposerAttachmentPill({ entry, hostEl, kind, name }: ComposerAttachmentPillProps) {
  const [viewing, setViewing] = useState(false)
  const tip = useHoverPreview()
  const { onEnter, onLeave } = tip

  useEffect(() => {
    hostEl.classList.toggle('attachment-error', entry?.status === 'error')
    return () => hostEl.classList.remove('attachment-error')
  }, [hostEl, entry?.status])

  // NodeView span 使用原生监听；锚点与预览卡共用进入和离开回调。
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
        ? // 灯箱挂在 body，避免继承 contenteditable 样式。
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
