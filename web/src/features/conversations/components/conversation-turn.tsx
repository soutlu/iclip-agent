/**
 * 一轮对话：用户说的那条，加模型这一轮做的每一块。
 *
 * 结构照协议的 turn → step → frame 铺开，不再折成「消息」：步的边界是模型每一次响应，界面上
 * 不需要它，所以只按块顺序排。连续的思考块与工具调用攒成一行可折叠的活动组（照 kimi 网页版
 * 的 activity-run，分组与聚合文案在 ./activity-group，组件在 ./activity-run）；单块的渲染
 * 分派在 ./turn-frame。
 *
 * 整页只有用户气泡一处填充（见 design-system.html 的 05 · CHAT）：工具行与思考块都是一行文字
 * 加一个图标，不进卡片。开合照 kimi 网页版用 grid-rows 0fr→1fr 平滑过渡，不再用 <details>。
 */

import { memo } from 'react'
import type { TranscriptTurn } from '@/shared/transcript/vendor'
import { groupTurnEntries } from './activity-group'
import { ActivityRun } from './activity-run'
import { ErrorNotice, TurnFrame } from './turn-frame'
import { TurnActions } from './turn-actions'
import { UserBubble } from './user-bubble'

type ConversationTurnProps = {
  turn: TranscriptTurn
  /** 重新生成这一轮；只在调用方判定它能重生（最后一轮、对话空闲）时才传。 */
  onRegenerate?: (() => void) | undefined
  /** 重新生成暂不可用时置灰；onRegenerate 没传时无意义。 */
  regenerateDisabled?: boolean | undefined
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
 * @param props.onRegenerate - 重新生成回调。
 * @param props.regenerateDisabled - 重新生成暂不可用。
 * @returns 一轮的内容。
 */
export const ConversationTurn = memo(function ConversationTurn({
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
  // 开场输入始终在轮头部；user frame 只表示这一轮运行期间追加的插话，两者互不替代。
  // 「还在进行中」的块照 kimi 的判据：轮子没结束，且它是最后一步的最后一块
  const liveFrameId = settled ? undefined : turn.steps.at(-1)?.frames.at(-1)?.frameId
  const nodes = groupTurnEntries(entries)

  return (
    <article className="group flex flex-col gap-2.5" aria-label={`第 ${turn.ordinal} 轮`}>
      {turn.content.length > 0 ? <UserBubble content={turn.content} /> : null}
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
