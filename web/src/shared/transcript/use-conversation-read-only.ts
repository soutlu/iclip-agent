import { useUser } from '@/shared/auth'
import type { TranscriptView } from './reader'

/** 对话已就绪，且属主不是登录人或对话已被删时只读；两种情况都只有治理者复盘会遇到。基线未到不算只读。 */
export const useConversationReadOnly = (view: TranscriptView): boolean => {
  const { data: user } = useUser()
  if (view.status !== 'ready' || user == null) return false
  return view.ownerUserId !== user.id || view.deletedAt !== null
}
