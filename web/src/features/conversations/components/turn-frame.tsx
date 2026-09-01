/**
 * 一块的渲染分派：用户气泡 / 助手正文 / 思考块 / 工具行 / 通知。
 *
 * 从 conversation-turn 拆出来：活动组（activity-run）里每一条就是普通的一块，两边共用这一个
 * 分派，拆开才不至于循环引用。
 */

import { useEffect, useRef, useState } from 'react'
import type { TranscriptAttachment, TranscriptFrame } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { AssistantMarkdown } from './assistant-markdown'
import { toolCard } from './tool-display'
import { UserBubble } from './user-bubble'

export type AttachmentMap = ReadonlyMap<string, TranscriptAttachment>

type TurnFrameProps = {
  frame: TranscriptFrame
  /** 附件实体表（frame 只带 id 引用）。 */
  attachments: AttachmentMap
  /** 这一块是整轮最新的一块且轮子还在跑（思考块据此计时与呼吸）。 */
  live: boolean
  settled: boolean
}

/**
 * 渲染一块。
 *
 * @param props - 组件属性。
 * @param props.frame - 这一块。
 * @param props.attachments - 附件实体表。
 * @param props.live - 这一块是否还在产出。
 * @param props.settled - 所在的轮子是否已结束。
 * @returns 一块的内容。
 */
export function TurnFrame({ attachments, frame, live, settled }: TurnFrameProps) {
  switch (frame.kind) {
    case 'text':
      // 用户那条按原样显示（他打的就是字），助手正文走 markdown
      return frame.role === 'user' ? (
        <UserBubble
          attachments={frame.attachmentIds?.flatMap((id) => attachments.get(id) ?? [])}
          text={frame.text}
        />
      ) : (
        <AssistantMarkdown text={frame.text} />
      )
    case 'thinking':
      return <ThinkingBlock live={live} text={frame.text} />
    case 'tool':
      return <ToolRow frame={frame} settled={settled} />
    case 'notice':
      return frame.level === 'error' ? (
        <p className="rounded-sm border border-chat-error-border bg-chat-error-bg px-3 py-2 text-body-sm text-chat-error-text">
          {frame.message}
        </p>
      ) : (
        <p className="text-body-sm text-chat-muted-text">{frame.message}</p>
      )
  }
}

/**
 * 思考计时（照 kimi）：块还在产出就开始走秒，轮子收尾后冻结在最后读数；历史里早已结束的
 * 思考块本地没账本，不显示时长。
 *
 * @param live - 这块思考是否还在产出。
 * @returns 秒数；没计过时为 null。
 */
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

  // 走秒从 0 开始：第一拍（1s 后）之前用 0 顶上
  return live ? (seconds ?? 0) : seconds
}

/**
 * 思考块：一行标题（走秒计时），点开才显示正文。还在产出时标题呼吸、文案是「思考中…」。
 *
 * @param props - 组件属性。
 * @param props.live - 这块思考是否还在产出。
 * @param props.text - 思考正文。
 * @returns 思考块。
 */
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
        <Icon
          className={cn('transition-transform duration-(--dur-s)', open && 'rotate-180')}
          decorative
          name="expand"
          size="sm"
        />
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-(--dur-s) ease-(--ease)',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="pt-1 pb-2 text-body-sm leading-relaxed whitespace-pre-wrap text-chat-secondary-text">
            {text}
          </p>
        </div>
      </div>
    </div>
  )
}

type ToolRowProps = {
  frame: Extract<TranscriptFrame, { kind: 'tool' }>
  settled: boolean
}

/**
 * 一次工具调用：一行——图标、做了什么、对象、行尾一个状态点；结果是纯文本时可以展开看，
 * 开合是 grid-rows 平滑过渡（照 kimi）。
 *
 * 轮子结束了还停在 `running` 的强制收尾：不这样的话，用户按停止之后会留下永远转圈的行。
 *
 * @param props - 组件属性。
 * @param props.frame - 这次调用。
 * @param props.settled - 所在的轮子是否已结束。
 * @returns 工具行。
 */
function ToolRow({ frame, settled }: ToolRowProps) {
  const card = toolCard(frame.display)
  const state = frame.state === 'running' && settled ? 'done' : frame.state
  const status = toolStatus[state]
  const [open, setOpen] = useState(false)
  // 只展开纯文本的结果（读文件、搜内容这些）。对象结果不塞进界面——那是内部形状，不是给人看的。
  const output = typeof frame.output === 'string' && frame.output !== '' ? frame.output : undefined

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
            <Icon
              className={cn(
                'shrink-0 text-chat-muted-text transition-transform duration-(--dur-s)',
                open && 'rotate-180',
              )}
              decorative
              name="expand"
              size="sm"
            />
          </button>
          <div
            className={cn(
              'grid transition-[grid-template-rows] duration-(--dur-s) ease-(--ease)',
              open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <pre className="mt-1 max-h-64 overflow-auto rounded-sm bg-chat-code-block-bg px-3 py-2 font-mono text-body-sm whitespace-pre-wrap text-chat-secondary-text">
                {output}
              </pre>
            </div>
          </div>
        </>
      )}
      {frame.error === undefined ? null : (
        <p className="text-body-sm text-chat-error-text">{frame.error}</p>
      )}
    </div>
  )
}

const toolStatus = {
  done: { color: 'text-chat-status-success', label: '完成', name: 'success' },
  error: { color: 'text-chat-status-error', label: '出错', name: 'failed' },
  running: { color: 'text-chat-status-running', label: '进行中', name: 'loading' },
} as const
