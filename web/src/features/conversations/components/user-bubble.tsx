/** 用户输入与乐观气泡共用渲染，保持文字和媒体顺序；参考 Kimi 用户气泡，超过十行可折叠。 */

import { useState } from 'react'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import {
  MEDIA_KIND_ICON,
  type MediaDescriptor,
  mediaDisplayName,
  MediaPreviewCard,
  mediaThumbnailUrl,
  useHoverPreview,
} from '@/shared/ui/media-preview'
import { CopyButton } from './copy-button'
import { useClampable } from './use-clampable'

type UserBubbleProps = {
  content: readonly PromptContentPart[]
  className?: string
  /** 仅为末轮开场输入提供修改入口。 */
  onEdit?: (() => void) | undefined
  editDisabled?: boolean | undefined
}

const plainText = (content: readonly PromptContentPart[]): string =>
  content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

type MediaPart = Extract<PromptContentPart, { type: 'image' | 'video' }>

export function UserBubble({ className, content, editDisabled = false, onEdit }: UserBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const [viewing, setViewing] = useState<LightboxMedia | null>(null)
  const { clampable, ref } = useClampable(10, content)

  const toggle = (
    <button
      className="ui-state rounded-full border-[0.5px] border-chat-hairline bg-top-layer px-4 py-1.5 text-body-sm text-chat-secondary-text shadow-[var(--shadow-1)] ui-focus"
      onClick={() => setExpanded((value) => !value)}
      type="button"
    >
      {expanded ? '收起' : '展开'}
    </button>
  )

  return (
    <div
      className={cn('group/bubble flex max-w-[min(88%,100vw-52px)] flex-col self-end', className)}
    >
      <div className="rounded-md bg-chat-user-bg px-3 py-2.5 text-body leading-normal whitespace-pre-wrap text-chat-message-text">
        <div className="relative flex flex-col">
          <div ref={ref} className={cn(clampable && !expanded && 'chat-clamp')}>
            {content.map((part, index) =>
              // 消息确定后 part 顺序不再变化，可用位置作为 key。
              part.type === 'text' ? (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <span key={index}>{part.text}</span>
              ) : (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <MediaChip key={index} onOpen={setViewing} part={part} />
              ),
            )}
          </div>
          {clampable && !expanded ? (
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2">{toggle}</div>
          ) : null}
        </div>
      </div>
      {clampable && expanded ? <div className="mt-1 self-center">{toggle}</div> : null}
      <div className="flex justify-end gap-2 pt-1 opacity-0 transition-opacity ui-motion-s group-hover/bubble:opacity-100 focus-within:opacity-100">
        <CopyButton label="复制消息" text={plainText(content)} />
        {onEdit === undefined ? null : (
          <IconButton
            className="text-chat-muted-text"
            disabled={editDisabled}
            label="修改"
            name="edit"
            onClick={onEdit}
            size="xs"
            title="修改"
            variant="standard"
          />
        )}
      </div>
      <MediaLightbox media={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

/** 与输入框共用媒体预览；OSS 视频可取首帧缩略图，其他视频显示类型图标。 */
function MediaChip({ onOpen, part }: { part: MediaPart; onOpen: (media: LightboxMedia) => void }) {
  // 用 state 接收锚点元素，避免在渲染期读取 ref.current。
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null)
  const tip = useHoverPreview()
  const url = part.source.url
  const media: MediaDescriptor = { kind: part.type, name: fileNameOfUrl(url), previewUrl: url }
  const name = mediaDisplayName(media)
  const thumbnail = mediaThumbnailUrl(media)
  const open = () => {
    tip.close()
    onOpen({ kind: part.type, name, url })
  }

  return (
    <>
      {/* 外壳占满行高并居中芯片，避免字体基线影响对齐。 */}
      <button
        aria-label={name}
        className="mx-0.5 inline-flex h-[1lh] cursor-pointer items-center align-top text-chat-muted-text ui-focus ui-motion-s hover:text-chat-message-text"
        onClick={open}
        onMouseEnter={tip.onEnter}
        onMouseLeave={tip.onLeave}
        ref={setAnchorEl}
        type="button"
      >
        <span className="flex h-4 items-center overflow-hidden rounded-xs border-[0.5px] border-chat-hairline">
          {thumbnail === undefined ? null : (
            <img alt="" className="aspect-square h-full object-cover" src={thumbnail} />
          )}
          <span className="flex h-full items-center px-[3px]">
            <Icon decorative name={MEDIA_KIND_ICON[media.kind]} size="xs" />
          </span>
        </span>
      </button>
      {tip.open && anchorEl !== null ? (
        <MediaPreviewCard
          anchorEl={anchorEl}
          media={media}
          onEnter={tip.onEnter}
          onLeave={tip.onLeave}
          onOpenFullscreen={open}
        />
      ) : null}
    </>
  )
}
