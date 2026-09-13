import { useUser } from '@/shared/auth'
import type { TranscriptView } from './reader'

/** 对话已就绪且属主不是登录人时只读；治理者看别人的对话就是这种情况。基线未到不算只读。 */
export const useConversationReadOnly = (view: TranscriptView): boolean => {
  const { data: user } = useUser()
  return view.status === 'ready' && user != null && view.ownerUserId !== user.id
}
