/** 单块分派由普通轮次与活动组共用，避免两者循环依赖。 */

import { useEffect, useRef, useState } from 'react'
import type { TranscriptFrame } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { ToolLine } from './tool-line'
import { UserBubble } from './user-bubble'

type TurnFrameProps = {
  frame: TranscriptFrame
  /** 未结束轮次的最后一块，用于思考计时与动效。 */
  live: boolean
  settled: boolean
}

export function TurnFrame({ frame, live, settled }: TurnFrameProps) {
  switch (frame.kind) {
    case 'text':
      return frame.role === 'user' ? (
        <UserBubble content={frame.content} />
      ) : (
        <Markdown text={frame.text} />
      )
    case 'thinking':
      return <ThinkingBlock live={live} text={frame.text} />
    case 'tool':
      return <ToolLine frame={frame} settled={settled} />
    case 'notice':
      return frame.level === 'error' ? (
        <ErrorNotice message={frame.message} />
      ) : (
        <p className="text-body-sm text-chat-muted-text">{frame.message}</p>
      )
  }
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <p className="rounded-sm border border-chat-error-border bg-chat-error-bg px-3 py-2 text-body-sm text-chat-error-text">
      {message}
    </p>
  )
}

/** 仅对实时思考块计时，结束时冻结；历史块没有本地计时记录，返回 null。 */
function useThinkingSeconds(live: boolean): number | null {
  const startedRef = useRef<number | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)

  useEffect(() => {
    if (!live) return
    startedRef.current ??= Date.now()
    const started = startedRef.current
    const id = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [live])

  return live ? (seconds ?? 0) : seconds
}

function ThinkingBlock({ live, text }: { live: boolean; text: string }) {
  const [open, setOpen] = useState(false)
  const seconds = useThinkingSeconds(live)

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1 rounded-xs py-1 text-left text-body-sm text-chat-muted-text ui-focus hover:text-chat-message-text"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Icon className="shrink-0" decorative name="thinking" size="sm" />
        <span className={cn('font-medium', live && 'animate-pulse')}>
          {live ? '思考中…' : '思考过程'}
        </span>
        {seconds === null ? null : <span>{seconds} 秒</span>}
        <DisclosureChevron open={open} />
      </button>
      <DisclosureBody open={open}>
        <p className="pt-1 pb-2 text-body-sm leading-relaxed whitespace-pre-wrap text-chat-secondary-text">
          {text}
        </p>
      </DisclosureBody>
    </div>
  )
}
