/**
 * 一轮对话：用户说的那条，加模型这一轮做的每一块。
 *
 * 结构照协议的 turn → step → frame 铺开，不再折成「消息」：步的边界是模型每一次响应，界面上
 * 不需要它，所以只按块顺序排。
 *
 * 整页只有用户气泡一处填充（见 design-system.html 的 05 · CHAT）：工具行与思考块都是一行文字
 * 加一个图标，不进卡片。
 */

import { memo } from 'react'
import type { TranscriptFrame, TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { toolCard } from './tool-display'

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

  return (
    <article className="flex flex-col gap-2.5" aria-label={`第 ${turn.ordinal} 轮`}>
      {promptOnly ? <UserBubble text={turn.prompt ?? ''} /> : null}
      {frames.map((frame) => (
        <TurnFrame key={frame.frameId} frame={frame} settled={settled} />
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
  settled: boolean
}

/**
 * 渲染一块。
 *
 * @param props - 组件属性。
 * @param props.frame - 这一块。
 * @param props.settled - 所在的轮子是否已结束。
 * @returns 一块的内容。
 */
function TurnFrame({ frame, settled }: TurnFrameProps) {
  switch (frame.kind) {
    case 'text':
      return frame.role === 'user' ? (
        <UserBubble text={frame.text} />
      ) : (
        <div className="text-body leading-relaxed font-medium whitespace-pre-wrap text-chat-message-text">
          {frame.text}
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={frame.text} />
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
 * 思考块：一行标题，点开才显示正文。
 *
 * 用 `<details>` 而不是自己记开合：一段对话里可能有几十块思考，浏览器自带的那套开合不用
 * 每块都挂一个 state。
 *
 * @param props - 组件属性。
 * @param props.text - 思考正文。
 * @returns 思考块。
 */
function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-body-sm text-chat-muted-text hover:text-chat-message-text">
        <Icon decorative name="thinking" size="sm" />
        思考过程
        <Icon
          className="transition-transform duration-(--dur-s) group-open:rotate-180"
          decorative
          name="expand"
          size="sm"
        />
      </summary>
      <p className="pt-1 pb-2 text-body-sm leading-relaxed whitespace-pre-wrap text-chat-secondary-text">
        {text}
      </p>
    </details>
  )
}

type ToolRowProps = {
  frame: Extract<TranscriptFrame, { kind: 'tool' }>
  settled: boolean
}

/**
 * 一次工具调用：一行——图标、做了什么、对象、行尾一个状态点。
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

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 py-1 text-body-sm">
        <Icon className="shrink-0 text-chat-muted-text" decorative name={card.icon} size="sm" />
        <span className="shrink-0 text-chat-secondary-text">{card.label}</span>
        {card.detail === undefined ? null : (
          <span className="min-w-0 truncate text-chat-message-text">{card.detail}</span>
        )}
        <Icon
          className={cn('ml-auto shrink-0', status.color, state === 'running' && 'animate-spin')}
          label={status.label}
          name={status.name}
          size="sm"
        />
      </div>
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
 * 页面那一层也用它画乐观气泡（还没被服务端记下的那条），两处必须是同一个形状。
 *
 * @param props - 组件属性。
 * @param props.text - 内容。
 * @returns 用户气泡。
 */
export function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[78%] self-end rounded-md bg-chat-user-bg px-3 py-2.5 text-body whitespace-pre-wrap text-chat-message-text">
      {text}
    </div>
  )
}
