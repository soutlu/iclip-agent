/** 单块分派由普通轮次与活动组共用，避免两者循环依赖。 */

import { useEffect, useRef, useState } from 'react'
import type { TranscriptFrame } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import { AssistantMarkdown } from './assistant-markdown'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { toolCard, toolMedia, type MediaGridItem } from './tool-display'
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
        <AssistantMarkdown text={frame.text} />
      )
    case 'thinking':
      return <ThinkingBlock live={live} text={frame.text} />
    case 'tool':
      return <ToolRow frame={frame} settled={settled} />
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

type ToolRowProps = {
  frame: Extract<TranscriptFrame, { kind: 'tool' }>
  settled: boolean
}

/** 结果渲染按 view 分派；轮次结束后将遗留 running 工具显示为结束，避免停止后持续转圈。 */
function ToolRow({ frame, settled }: ToolRowProps) {
  const card = toolCard(frame.display)
  const state = frame.state === 'running' && settled ? 'done' : frame.state
  const status = toolStatus[state]
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const media = toolMedia(frame)
  // 仅展开字符串结果，内部对象结构不展示给用户。
  const text = typeof frame.output === 'string' && frame.output !== '' ? frame.output : undefined
  const output = media.length > 0 ? undefined : text

  const head = (
    <>
      <Icon className="shrink-0 text-chat-muted-text" decorative name={card.icon} size="sm" />
      <span className="shrink-0 text-chat-muted-text">{card.label}</span>
      {card.detail === undefined ? null : (
        <span className="max-w-[60%] min-w-0 truncate text-chat-message-text">{card.detail}</span>
      )}
      <Icon
        className={cn('ml-auto shrink-0', status.color, state === 'running' && 'animate-spin')}
        label={status.label}
        name={status.name}
        size="sm"
      />
    </>
  )

  return (
    <div className="flex flex-col">
      {output === undefined ? (
        <div className="flex items-center gap-1 py-1 text-body-sm">{head}</div>
      ) : (
        <>
          <button
            aria-expanded={open}
            className="flex w-full cursor-pointer items-center gap-1 rounded-xs py-1 text-left text-body-sm ui-focus"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {head}
            <DisclosureChevron className="shrink-0 text-chat-muted-text" open={open} />
          </button>
          <DisclosureBody open={open}>
            <pre className="mt-1 max-h-64 overflow-auto rounded-sm bg-chat-code-block-bg px-3 py-2 font-mono text-body-sm whitespace-pre-wrap text-chat-secondary-text">
              {output}
            </pre>
          </DisclosureBody>
        </>
      )}
      {media.length === 0 ? null : <MediaWall items={media} onOpen={setPreview} />}
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
      {frame.error === undefined ? null : (
        <p className="text-body-sm text-chat-error-text">{frame.error}</p>
      )}
    </div>
  )
}

function MediaWall({
  items,
  onOpen,
}: {
  items: readonly MediaGridItem[]
  onOpen: (media: LightboxMedia) => void
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {items.map((item) => (
        <figure
          className="flex max-w-[320px] min-w-0 flex-col gap-1.5 max-sm:w-[min(44vw,160px)]"
          key={item.url}
        >
          <button
            className="cursor-zoom-in overflow-hidden rounded-md ui-focus"
            onClick={() => onOpen({ kind: 'image', name: item.caption, url: item.url })}
            type="button"
          >
            <img alt={item.caption} className="block w-full rounded-md" src={item.url} />
          </button>
          <figcaption className="truncate text-body-sm text-chat-muted-text">
            {item.caption}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

const toolStatus = {
  done: { color: 'text-chat-status-success', label: '完成', name: 'success' },
  error: { color: 'text-chat-status-error', label: '出错', name: 'failed' },
  running: { color: 'text-chat-status-running', label: '进行中', name: 'loading' },
} as const
