/**
 * 一轮对话：用户说的那条，加模型这一轮做的每一块。
 *
 * 结构照协议的 turn → step → frame 铺开，不再折成「消息」：步的边界是模型每一次响应，界面上
 * 不需要它，所以只按块顺序排。
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
    <article className="flex flex-col gap-4" aria-label={`第 ${turn.ordinal} 轮`}>
      {promptOnly ? <UserBubble text={turn.prompt ?? ''} /> : null}
      {frames.map((frame) => (
        <TurnFrame key={frame.frameId} frame={frame} settled={settled} />
      ))}
      {turn.error === undefined ? null : (
        <p className="rounded-lg border border-chat-error-border bg-chat-error-bg px-3 py-2 text-body-sm text-chat-error-text">
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
        <div className="text-body whitespace-pre-wrap text-chat-message-text">{frame.text}</div>
      )
    case 'thinking':
      return (
        <details className="rounded-lg border border-chat-inline-border bg-chat-inline-bg px-3 py-2">
          <summary className="cursor-pointer text-body-sm text-chat-secondary-text">
            思考过程
          </summary>
          <div className="pt-2 text-body-sm whitespace-pre-wrap text-chat-secondary-text">
            {frame.text}
          </div>
        </details>
      )
    case 'tool':
      return <ToolFrameCard frame={frame} settled={settled} />
    case 'notice':
      return (
        <p
          className={cn(
            'rounded-lg px-3 py-2 text-body-sm',
            frame.level === 'error'
              ? 'border border-chat-error-border bg-chat-error-bg text-chat-error-text'
              : 'bg-chat-inline-bg text-chat-secondary-text',
          )}
        >
          {frame.message}
        </p>
      )
  }
}

type ToolFrameCardProps = {
  frame: Extract<TranscriptFrame, { kind: 'tool' }>
  settled: boolean
}

/**
 * 一张工具卡。
 *
 * 轮子结束了还停在 `running` 的强制收尾：不这样的话，用户按停止之后会留下永远转圈的卡片。
 *
 * @param props - 组件属性。
 * @param props.frame - 这次调用。
 * @param props.settled - 所在的轮子是否已结束。
 * @returns 工具卡。
 */
function ToolFrameCard({ frame, settled }: ToolFrameCardProps) {
  const card = toolCard(frame.display)
  const state = frame.state === 'running' && settled ? 'done' : frame.state

  return (
    <div className="flex items-start gap-2 rounded-lg border border-chat-tool-border bg-chat-tool-bg px-3 py-2">
      <Icon className="mt-0.5 text-chat-secondary-text" decorative name={card.icon} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-body-sm text-chat-message-text">{card.label}</p>
        {card.detail === undefined ? null : (
          <p className="truncate text-body-sm text-chat-muted-text">{card.detail}</p>
        )}
        {frame.error === undefined ? null : (
          <p className="pt-1 text-body-sm text-chat-error-text">{frame.error}</p>
        )}
      </div>
      <ToolState state={state} />
    </div>
  )
}

const toolStateIcons = {
  done: { color: 'text-chat-status-success', label: '完成', name: 'success' },
  error: { color: 'text-chat-status-error', label: '出错', name: 'failed' },
  running: { color: 'text-chat-status-running', label: '进行中', name: 'loading' },
} as const

/**
 * 工具卡右边那个状态点。
 *
 * @param props - 组件属性。
 * @param props.state - 这次调用的状态。
 * @returns 状态图标。
 */
function ToolState({ state }: { state: 'running' | 'done' | 'error' }) {
  const icon = toolStateIcons[state]
  return (
    <Icon
      className={cn(icon.color, state === 'running' && 'animate-spin')}
      label={icon.label}
      name={icon.name}
      size="sm"
    />
  )
}

type UserBubbleProps = {
  text: string
}

/**
 * 用户说的那一条。
 *
 * @param props - 组件属性。
 * @param props.text - 内容。
 * @returns 用户气泡。
 */
function UserBubble({ text }: UserBubbleProps) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-xl border border-chat-user-border bg-chat-user-bg px-4 py-2.5 text-body whitespace-pre-wrap text-chat-message-text shadow-[var(--shadow-chat-user)]">
        {text}
      </div>
    </div>
  )
}
