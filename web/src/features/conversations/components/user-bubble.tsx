/**
 * 用户说的那一条。整页只有它带填充。
 *
 * 形状照 kimi 网页版：text-body 14px、行高 1.5、≤ min(88%, 100vw-52px)；附件芯片排在文字
 * 上方；超过 10 行折叠成底部渐隐，「展开」胶囊压在渐隐上，展开后胶囊挪到气泡下变成「收起」。
 * 页面那一层也用它画乐观气泡，两处必须是同一个形状。
 */

import { useState } from 'react'
import type { TranscriptAttachment } from '@/shared/transcript/vendor'
import { cn } from '@/shared/lib/utils'
import { AttachmentPills } from './attachment-pills'
import { useClampable } from './use-clampable'

type UserBubbleProps = {
  text: string
  /** 这条消息引用的附件实体；没引就不给。 */
  attachments?: readonly TranscriptAttachment[] | undefined
  /** 外层附加类名（排队气泡用它压暗）。 */
  className?: string
}

/**
 * 渲染用户气泡。
 *
 * @param props - 组件属性。
 * @param props.text - 内容。
 * @param props.attachments - 附件实体。
 * @param props.className - 外层附加类名。
 * @returns 用户气泡。
 */
export function UserBubble({ attachments, className, text }: UserBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const { clampable, ref } = useClampable(10, text)

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
    <div className={cn('flex max-w-[min(88%,100vw-52px)] flex-col self-end', className)}>
      <div className="rounded-md bg-chat-user-bg px-3 py-2.5 text-body leading-normal whitespace-pre-wrap text-chat-message-text">
        {attachments === undefined ? null : <AttachmentPills attachments={attachments} />}
        <div className="relative flex flex-col">
          <div ref={ref} className={cn(clampable && !expanded && 'chat-clamp')}>
            {text}
          </div>
          {/* 折叠时胶囊压在底部渐隐上（照 kimi 的 u-text-toggle） */}
          {clampable && !expanded ? (
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2">{toggle}</div>
          ) : null}
        </div>
      </div>
      {clampable && expanded ? <div className="mt-1 self-center">{toggle}</div> : null}
    </div>
  )
}
