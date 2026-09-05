/** 乐观气泡由谁接替：先按 id，轮头 triggerPromptId 认发出去的那句，插话块 promptIds 认插队的那句；服务端没给 id 的才退回比内容。 */

import type {
  PromptContentPart,
  TranscriptPrompt,
  TranscriptTurn,
} from '@/shared/transcript/vendor'

export type PendingPrompt = {
  promptId: string
  content: readonly PromptContentPart[]
}

export const sameContent = (a: readonly PromptContentPart[], b: readonly PromptContentPart[]) =>
  a.length === b.length &&
  a.every((part, index) => {
    const other = b[index]
    if (other === undefined || other.type !== part.type) return false
    return part.type === 'text'
      ? other.type === 'text' && other.text === part.text
      : other.type !== 'text' && other.source.url === part.source.url
  })

const steeredInto = (turn: TranscriptTurn, promptId: string): boolean =>
  turn.steps.some((step) =>
    step.frames.some(
      (frame) =>
        frame.kind === 'text' &&
        frame.role === 'user' &&
        (frame.promptIds ?? []).includes(promptId),
    ),
  )

/**
 * 排队中的由队列行显示，到终态的直接撤；其余看时间线里有没有认领它的轮或插话块。
 * 只有没带 triggerPromptId 的轮才按内容认，带了 id 却对不上的不算，避免认错同样内容的旧轮。
 */
export const claimed = (
  item: PendingPrompt,
  turns: readonly TranscriptTurn[],
  prompts: ReadonlyMap<string, TranscriptPrompt>,
): boolean => {
  const prompt = prompts.get(item.promptId)
  if (prompt?.status === 'queued') return true
  if (prompt !== undefined && prompt.status !== 'running') return true
  return turns.some(
    (turn) =>
      turn.triggerPromptId === item.promptId ||
      steeredInto(turn, item.promptId) ||
      // 只有运行没有消息映射的旧轮才没有 id；别把这条放宽成一般的内容比对。
      (turn.triggerPromptId === undefined && sameContent(turn.content, item.content)),
  )
}
