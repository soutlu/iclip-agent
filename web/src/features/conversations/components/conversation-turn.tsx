/**
 * 一轮对话：用户说的那条，加模型这一轮做的每一块。
 *
 * 结构照协议的 turn → step → frame 铺开，不再折成「消息」：步的边界是模型每一次响应，界面上
 * 不需要它，所以只按块顺序排。
 *
 * 整页只有用户气泡一处填充（见 design-system.html 的 05 · CHAT）：工具行与思考块都是一行文字
 * 加一个图标，不进卡片。开合照 kimi 网页版用 grid-rows 0fr→1fr 平滑过渡，不再用 <details>。
 */

import { memo, useEffect, useRef, useState } from 'react'
import type { TranscriptFrame, TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { AssistantMarkdown } from './assistant-markdown'
import { toolCard } from './tool-display'
import { useClampable } from './use-clampable'

type ConversationTurnProps = {
  turn: TranscriptTurn
}

/** 这一轮是不是已经结束了。结束了的轮子里不该再有转圈的东西。 */
const isSettled = (turn: TranscriptTurn) => turn.state !== 'running' && turn.state !== 'queued'

/**
 * 渲染一轮。
 *
 * 轮子按 `turnId` memo：流式期间每来一批操作都会换掉时间线数组，不这样分的话，前面几十轮
 * 每个字都跟着重渲一遍。
 *
 * @param props - 组件属性。
 * @param props.turn - 这一轮。
 * @returns 一轮的内容。
 */
export const ConversationTurn = memo(function ConversationTurn({ turn }: ConversationTurnProps) {
  const settled = isSettled(turn)
  const frames = turn.steps.flatMap((step) => step.frames)
  // 第一次模型响应之前，用户说的那条只在轮头部；等第一步开出来它会变成一个 user 块。
  const promptOnly = frames.length === 0 && turn.prompt !== undefined
  // 「还在进行中」的块照 kimi 的判据：轮子没结束，且它是最后一步的最后一块
  const liveFrameId = settled ? undefined : turn.steps.at(-1)?.frames.at(-1)?.frameId

  return (
    <article className="flex flex-col gap-2.5" aria-label={`第 ${turn.ordinal} 轮`}>
      {promptOnly ? <UserBubble text={turn.prompt ?? ''} /> : null}
      {frames.map((frame) => (
        <TurnFrame
          key={frame.frameId}
          frame={frame}
          live={frame.frameId === liveFrameId}
          settled={settled}
        />
      ))}
      {turn.error === undefined ? null : (
        <p className="rounded-sm border border-chat-error-border bg-chat-error-bg px-3 py-2 text-body-sm text-chat-error-text">
          {turn.error}
        </p>
      )}
      {turn.state === 'queued' ? (
        <p className="text-body-sm text-chat-muted-text">排队中，等前一条跑完</p>
      ) : null}
    </article>
  )
})

type TurnFrameProps = {
  frame: TranscriptFrame
  /** 这一块是整轮最新的一块且轮子还在跑（思考块据此计时与呼吸）。 */
  live: boolean
  settled: boolean
}

/**
 * 渲染一块。
 *
 * @param props - 组件属性。
 * @param props.frame - 这一块。
 * @param props.live - 这一块是否还在产出。
 * @param props.settled - 所在的轮子是否已结束。
 * @returns 一块的内容。
 */
function TurnFrame({ frame, live, settled }: TurnFrameProps) {
  switch (frame.kind) {
    case 'text':
      // 用户那条按原样显示（他打的就是字），助手正文走 markdown
      return frame.role === 'user' ? (
        <UserBubble text={frame.text} />
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

/**
 * 用户说的那一条。整页只有它带填充。
 *
 * 形状照 kimi 网页版：text-body 14px、行高 1.5、≤ min(88%, 100vw-52px)；超过 10 行折叠成
 * 底部渐隐，「展开」胶囊压在渐隐上，展开后胶囊挪到气泡下变成「收起」。页面那一层也用它画
 * 乐观气泡，两处必须是同一个形状。
 *
 * @param props - 组件属性。
 * @param props.text - 内容。
 * @param props.className - 外层附加类名。
 * @returns 用户气泡。
 */
export function UserBubble({ className, text }: { className?: string; text: string }) {
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
