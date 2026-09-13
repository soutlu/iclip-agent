/** 由 activity 推出的一格状态，侧栏行尾角标与全部对话页的状态列共用同一套词。 */

import type { IconName } from '@/shared/icons'
import type { Conversation } from './conversations.api'

export type ConversationStatus =
  'approval' | 'question' | 'running' | 'failed' | 'completed' | 'aborted' | 'idle'

/** 优先级：待审批、待回答、运行、失败、完成、中止、从没跑过。 */
export const conversationStatus = (activity: Conversation['activity']): ConversationStatus => {
  if (activity.pendingInteraction === 'approval') return 'approval'
  if (activity.pendingInteraction === 'question') return 'question'
  if (activity.busy) return 'running'
  if (activity.lastTurnReason === 'failed') return 'failed'
  if (activity.lastTurnReason === 'completed') return 'completed'
  if (activity.lastTurnReason === 'aborted') return 'aborted'
  return 'idle'
}

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  aborted: '已中止',
  approval: '等待审批',
  completed: '已完成',
  failed: '上次失败',
  idle: '未运行',
  question: '等待回答',
  running: '进行中',
}

/** 侧栏行尾只画还需要人看一眼的四种；完成与中止不画，未读另有小点。 */
export const CONVERSATION_STATUS_MARKS: Record<
  Extract<ConversationStatus, 'approval' | 'question' | 'running' | 'failed'>,
  { className: string; label: string; name: IconName }
> = {
  approval: {
    className: 'text-warning',
    label: CONVERSATION_STATUS_LABELS.approval,
    name: 'warning',
  },
  failed: {
    className: 'text-chat-status-error',
    label: CONVERSATION_STATUS_LABELS.failed,
    name: 'failed',
  },
  question: {
    className: 'text-warning',
    label: CONVERSATION_STATUS_LABELS.question,
    name: 'warning',
  },
  running: {
    className: 'animate-spin text-primary',
    label: CONVERSATION_STATUS_LABELS.running,
    name: 'loading',
  },
}
