/**
 * 消息里引用的附件（照 kimi 的 attachment-pill）：气泡上部一排芯片，图片/视频点开灯箱，
 * 文件开新页。
 *
 * 附件实体走 `attachment.upsert` 进表，frame / turn 只带 id 引用（实体-引用分离）；这里收到的
 * 是已解析好的实体。没有地址（file / session_media 待接鉴权拉取）的画成删除线的弱化芯片。
 */

import { useState } from 'react'
import type { TranscriptAttachment } from '@/shared/transcript/vendor'
import { Icon, type IconName } from '@/shared/icons'
import { MediaLightbox } from './media-lightbox'

type AttachmentKind = 'image' | 'video' | 'file'

const kindOf = (mediaType: string): AttachmentKind =>
  mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('video/') ? 'video' : 'file'

const KIND_ICON: Record<AttachmentKind, IconName> = { file: 'file', image: 'image', video: 'video' }
const KIND_FALLBACK_NAME: Record<AttachmentKind, string> = {
  file: '附件',
  image: '图片',
  video: '视频',
}

/**
 * 渲染一排附件芯片。
 *
 * @param props - 组件属性。
 * @param props.attachments - 这条消息引用的附件实体。
 * @returns 附件芯片排；没有附件就不渲染。
 */
export function AttachmentPills({ attachments }: { attachments: readonly TranscriptAttachment[] }) {
  const [viewing, setViewing] = useState<TranscriptAttachment | null>(null)
  if (attachments.length === 0) return null

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {attachments.map((attachment) => {
          const kind = kindOf(attachment.mediaType)
          const url = attachment.source?.kind === 'url' ? attachment.source.url : undefined
          const name = attachment.name ?? KIND_FALLBACK_NAME[kind]
          const open = () => {
            if (url === undefined) return
            // 只有图片进灯箱；视频与文件开新页（灯箱那边只收图片，见 media-lightbox 的说明）
            if (kind === 'image') setViewing(attachment)
            else window.open(url, '_blank', 'noreferrer')
          }
          return url === undefined ? (
            <span
              key={attachment.attachmentId}
              className="inline-flex items-center gap-1 text-body-sm text-chat-muted-text line-through"
            >
              <Icon decorative name={KIND_ICON[kind]} size="sm" />
              {name}
            </span>
          ) : (
            <button
              key={attachment.attachmentId}
              className="inline-flex cursor-pointer items-center gap-1 rounded-xs text-body-sm text-chat-muted-text ui-focus ui-motion-s hover:text-chat-message-text hover:underline hover:underline-offset-2"
              onClick={open}
              type="button"
            >
              <Icon decorative name={KIND_ICON[kind]} size="sm" />
              <span className="max-w-40 truncate">{name}</span>
            </button>
          )
        })}
      </div>
      <MediaLightbox attachment={viewing} onClose={() => setViewing(null)} />
    </>
  )
}
