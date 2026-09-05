/** 按 turn → step → frame 顺序渲染，连续活动由 activity-group 分组，单块由 turn-frame 渲染。 */

import { memo } from 'react'
import type { TranscriptTurn } from '@/shared/transcript/vendor'
import { groupTurnEntries } from './activity-group'
import { ActivityRun } from './activity-run'
import { ErrorNotice, TurnFrame } from './turn-frame'
import { TurnActions } from './turn-actions'
import { UserBubble } from './user-bubble'

type ConversationTurnProps = {
  turn: TranscriptTurn
  /** 仅在末轮且对话空闲时提供重新生成回调。 */
  onRegenerate?: (() => void) | undefined
  regenerateDisabled?: boolean | undefined
  /** 仅为末轮提供修改开场输入的回调。 */
  onEdit?: (() => void) | undefined
  editDisabled?: boolean | undefined
}

const isSettled = (turn: TranscriptTurn) => turn.state !== 'running' && turn.state !== 'queued'

/** 按轮 memo，避免流式更新重渲历史轮次。 */
export const ConversationTurn = memo(function ConversationTurn({
  editDisabled,
  onEdit,
  onRegenerate,
  regenerateDisabled,
  turn,
}: ConversationTurnProps) {
  const settled = isSettled(turn)
  const entries = turn.steps.flatMap((step) => step.frames.map((frame) => ({ frame, step })))
  const lastUserFrameIndex = entries.findLastIndex(
    ({ frame }) => frame.kind === 'text' && frame.role === 'user',
  )
  const copyText = entries
    .slice(lastUserFrameIndex + 1)
    .flatMap(({ frame }) =>
      frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim().length > 0
        ? [frame.text]
        : [],
    )
    .join('\n\n')
  // 轮头部保存开场输入，user frame 保存运行中追加消息；live 块为未结束轮的末步末块。
  const liveFrameId = settled ? undefined : turn.steps.at(-1)?.frames.at(-1)?.frameId
  const nodes = groupTurnEntries(entries)

  return (
    <article className="group flex flex-col gap-2.5" aria-label={`第 ${turn.ordinal} 轮`}>
      {turn.content.length > 0 ? (
        <UserBubble content={turn.content} editDisabled={editDisabled} onEdit={onEdit} />
      ) : null}
      {nodes.map((node) =>
        node.kind === 'run' ? (
          <ActivityRun
            items={node.items}
            key={node.runId}
            liveFrameId={liveFrameId}
            settled={settled}
          />
        ) : (
          <TurnFrame
            frame={node.entry.frame}
            key={node.entry.frame.frameId}
            live={node.entry.frame.frameId === liveFrameId}
            settled={settled}
          />
        ),
      )}
      {settled && copyText !== '' ? (
        <TurnActions
          copyText={copyText}
          endedAt={turn.endedAt}
          onRegenerate={onRegenerate}
          regenerateDisabled={regenerateDisabled}
          usage={turn.usage}
        />
      ) : null}
      {turn.error === undefined ? null : <ErrorNotice message={turn.error} />}
      {turn.state === 'queued' ? (
        <p className="text-body-sm text-chat-muted-text">排队中，等前一条跑完</p>
      ) : null}
    </article>
  )
})
