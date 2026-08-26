import type { MessageState } from '@assistant-ui/react'
import type { Storyboard } from '@/features/storyboards/model/storyboard-workspace'

/** Storyboard 页面唯一消费的 Agent 运行阶段。 */
export type StoryboardAgentRunPhase = 'completed' | 'failed' | 'running'

/** 一次真实 Storyboard Agent 运行的用户可见快照。 */
export type StoryboardAgentRun = {
  conversationId: string
  errorMessage: null | string
  finalSeconds: null | number
  output: string
  phase: StoryboardAgentRunPhase
  startedAtMs: number
  title: string
  videoTaskId: string
}

const assistantText = (messages: readonly MessageState[]) =>
  messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

const runErrorMessage = (message: MessageState) => {
  if (message.status?.type === 'requires-action') {
    return '当前 Storyboard Agent 不支持人工中断。'
  }
  if (message.status?.type !== 'incomplete') return null
  return typeof message.status.error === 'string' && message.status.error.trim()
    ? message.status.error
    : 'Storyboard Agent 运行失败。'
}

/** 从 Assistant UI 当前 thread 投影产品展示所需的运行信息。 */
export const storyboardAgentRunFromThread = (
  storyboard: Storyboard,
  messages: readonly MessageState[],
  isRunning: boolean,
): StoryboardAgentRun | null => {
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const runMessages = messages.slice(latestUserIndex + 1)
  const assistantMessage = runMessages.findLast((message) => message.role === 'assistant')
  if (!assistantMessage) return null

  const output = assistantText(runMessages)
  const errorMessage = runErrorMessage(assistantMessage)
  const timing = assistantMessage.metadata.timing
  const startedAtMs = timing?.streamStartTime ?? assistantMessage.createdAt.getTime()
  const finalSeconds = timing?.totalStreamTime ? timing.totalStreamTime / 1_000 : 0

  if (errorMessage) {
    return {
      errorMessage,
      finalSeconds,
      output,
      phase: 'failed',
      conversationId: storyboard.conversationId,
      startedAtMs,
      title: storyboard.title,
      videoTaskId: storyboard.videoTaskId,
    }
  }

  if (isRunning || assistantMessage.status?.type === 'running') {
    return {
      errorMessage: null,
      finalSeconds: null,
      output,
      phase: 'running',
      conversationId: storyboard.conversationId,
      startedAtMs,
      title: storyboard.title,
      videoTaskId: storyboard.videoTaskId,
    }
  }

  return {
    errorMessage: output.trim() ? null : 'Storyboard Agent 已结束，但没有返回 Storyboard 内容。',
    finalSeconds,
    output,
    phase: output.trim() ? 'completed' : 'failed',
    conversationId: storyboard.conversationId,
    startedAtMs,
    title: storyboard.title,
    videoTaskId: storyboard.videoTaskId,
  }
}
