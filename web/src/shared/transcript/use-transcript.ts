import { use, useEffect, useMemo, useSyncExternalStore } from 'react'
import { MAIN_AGENT_ID } from './connection'
import type { TranscriptView } from './reader'
import { TranscriptReadersContext } from './transcript-context'

/** 订一段对话里某个 agent 的流；同一段流多处同时用时共享一个读取器。 */
export const useTranscript = (
  conversationId: string,
  agentId: string = MAIN_AGENT_ID,
): { view: TranscriptView; refresh: () => void } => {
  const readers = use(TranscriptReadersContext)
  if (readers === null) throw new Error('useTranscript 要在 TranscriptProvider 里用')

  const reader = useMemo(
    () => readers.get(conversationId, agentId),
    [readers, conversationId, agentId],
  )

  useEffect(() => readers.retain(reader), [readers, reader])

  const view = useSyncExternalStore(
    (onChange) => reader.listen(onChange),
    () => reader.view(),
  )

  return { refresh: () => reader.refresh(), view }
}
