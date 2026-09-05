import { use, useEffect, useMemo, useSyncExternalStore } from 'react'
import { TranscriptReader, type TranscriptView } from './reader'
import { TranscriptConnectionContext } from './transcript-context'

export const useTranscript = (
  conversationId: string,
): { view: TranscriptView; refresh: () => void } => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useTranscript 要在 TranscriptProvider 里用')

  const reader = useMemo(
    () => new TranscriptReader(conversationId, connection),
    [conversationId, connection],
  )

  useEffect(() => {
    reader.start()
    return () => reader.stop()
  }, [reader])

  const view = useSyncExternalStore(
    (onChange) => reader.listen(onChange),
    () => reader.view(),
  )

  return { refresh: () => reader.refresh(), view }
}
