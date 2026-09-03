/**
 * 用户说的那一条。整页只有它带填充。
 *
 * 内容就是发消息时那串 part，按原顺序铺开：文字原样，图与视频落成内联芯片（缩略图 + 文件名），
 * 图在哪句话旁边就画在哪。形状照 kimi 网页版：text-body 14px、行高 1.5、≤ min(88%, 100vw-52px)；
 * 超过 10 行折叠成底部渐隐，「展开」胶囊压在渐隐上，展开后胶囊挪到气泡下变成「收起」。
 * 页面那一层也用它画乐观气泡，两处必须是同一个形状。
 */

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
  /** 这条消息的原样 part 列表。 */
  content: readonly PromptContentPart[]
  /** 外层附加类名（排队气泡用它压暗）。 */
  className?: string
  /** 修改这条消息；只有最后一轮的开场输入才传，其余气泡没有这颗钮。 */
  onEdit?: (() => void) | undefined
  /** 对话在忙时修改钮置灰；onEdit 没传时无意义。 */
  editDisabled?: boolean | undefined
}

/** 复制用的正文：文字 part 原样接起来，媒体不进剪贴板。 */
const plainText = (content: readonly PromptContentPart[]): string =>
  content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

type MediaPart = Extract<PromptContentPart, { type: 'image' | 'video' }>

/**
 * 渲染用户气泡。
 *
 * @param props - 组件属性。
 * @param props.content - 这条消息的 part 列表。
 * @param props.className - 外层附加类名。
 * @param props.onEdit - 修改这条消息。
 * @param props.editDisabled - 修改钮置灰。
 * @returns 用户气泡。
 */
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
              // part 列表是这条消息定下来就不变的，位置就是身份
              part.type === 'text' ? (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <span key={index}>{part.text}</span>
              ) : (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <MediaChip key={index} onOpen={setViewing} part={part} />
              ),
            )}
          </div>
          {/* 折叠时胶囊压在底部渐隐上（照 kimi 的 u-text-toggle） */}
          {clampable && !expanded ? (
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2">{toggle}</div>
          ) : null}
        </div>
      </div>
      {clampable && expanded ? <div className="mt-1 self-center">{toggle}</div> : null}
      {/* 动作行贴气泡右下，悬停这颗气泡（或键盘焦点落进来）才浮现 */}
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

/**
 * 一颗内联媒体芯片：一行高的缩略图接一枚种类角标，不带文件名（名字在悬停卡里）。
 * 与输入框 pill 共用悬停预览卡；悬停出卡、点开进灯箱（图与视频都进）。
 * 视频的缩略图是 OSS 截的首帧，别处的地址截不出来，那时只画一枚种类图标。
 *
 * @param props - 组件属性。
 * @param props.part - 图片或视频 part。
 * @param props.onOpen - 点开时给灯箱。
 * @returns 芯片。
 */
function MediaChip({ onOpen, part }: { part: MediaPart; onOpen: (media: LightboxMedia) => void }) {
  // 卡的锚点要的是元素本身，用状态接 ref 而不是读 ref.current（渲染期读 ref 不算数）
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
      {/* 外壳占满一行高、顶对齐，芯片在壳里居中：这样它和字一样落在行框正中，不受字体基线度量影响 */}
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
          {/* 图贴左边满高，角标带 3px 内距；两者在同一圈描边里，中间不留空 */}
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
