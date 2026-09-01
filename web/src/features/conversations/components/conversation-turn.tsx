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

import { memo, useState } from 'react'
import type { TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { toast } from '@/shared/ui/toast'
import { groupTurnEntries } from './activity-group'
import { ActivityRun } from './activity-run'
import { ErrorNotice, TurnFrame, type AttachmentMap } from './turn-frame'
import { UserBubble } from './user-bubble'

type ConversationTurnProps = {
  turn: TranscriptTurn
  /** 附件实体表（frame / turn 只带 id 引用；同一引用原地增补，不破坏 memo）。 */
  attachments: AttachmentMap
}

/** 这一轮是不是已经结束了。结束了的轮子里不该再有转圈的东西。 */
const isSettled = (turn: TranscriptTurn) => turn.state !== 'running' && turn.state !== 'queued'

const COPY_FEEDBACK_MS = 1400

/**
 * 渲染一轮。
 *
 * 轮子按 `turnId` memo：流式期间每来一批操作都会换掉时间线数组，不这样分的话，前面几十轮
 * 每个字都跟着重渲一遍。attachments 是同一份原地增补的表，引用不变、不破坏 memo。
 *
 * @param props - 组件属性。
 * @param props.turn - 这一轮。
 * @param props.attachments - 附件实体表。
 * @returns 一轮的内容。
 */
export const ConversationTurn = memo(function ConversationTurn({
  attachments,
  turn,
}: ConversationTurnProps) {
  const [copied, setCopied] = useState(false)
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
  const copyReply = async () => {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    } catch {
      toast.error('复制失败')
    }
  }
  // 开场输入始终在轮头部；user frame 只表示这一轮运行期间追加的插话，两者互不替代。
  const hasOpening = (turn.prompt?.length ?? 0) > 0 || (turn.attachmentIds?.length ?? 0) > 0
  // 「还在进行中」的块照 kimi 的判据：轮子没结束，且它是最后一步的最后一块
  const liveFrameId = settled ? undefined : turn.steps.at(-1)?.frames.at(-1)?.frameId
  const nodes = groupTurnEntries(entries)

  return (
    <article className="flex flex-col gap-2.5" aria-label={`第 ${turn.ordinal} 轮`}>
      {hasOpening ? (
        <UserBubble
          attachments={turn.attachmentIds?.flatMap((id) => attachments.get(id) ?? [])}
          text={turn.prompt ?? ''}
        />
      ) : null}
      {nodes.map((node) =>
        node.kind === 'run' ? (
          <ActivityRun
            attachments={attachments}
            items={node.items}
            key={node.runId}
            liveFrameId={liveFrameId}
            settled={settled}
          />
        ) : (
          <TurnFrame
            attachments={attachments}
            frame={node.entry.frame}
            key={node.entry.frame.frameId}
            live={node.entry.frame.frameId === liveFrameId}
            settled={settled}
          />
        ),
      )}
      {settled && copyText !== '' ? (
        <button
          aria-label="复制"
          className="inline-flex min-h-[22px] cursor-pointer items-center justify-center self-start rounded-sm px-[5px] py-0.5 text-chat-muted-text opacity-70 ui-focus transition-[opacity,color,background-color] ui-motion-s hover:bg-hover hover:text-primary hover:opacity-100"
          onClick={() => void copyReply()}
          title="复制"
          type="button"
        >
          <Icon decorative name={copied ? 'check' : 'copy'} size="sm" />
        </button>
      ) : null}
      {turn.error === undefined ? null : <ErrorNotice message={turn.error} />}
      {turn.state === 'queued' ? (
        <p className="text-body-sm text-chat-muted-text">排队中，等前一条跑完</p>
      ) : null}
    </article>
  )
})
