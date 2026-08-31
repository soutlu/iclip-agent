/**
 * 读一段对话的内容：订阅、拉基线、补漏都在 `TranscriptReader` 里，界面只管渲染返回的这一份。
 */

import { use, useEffect, useMemo, useSyncExternalStore } from 'react'
import { TranscriptReader, type TranscriptView } from './reader'
import { TranscriptConnectionContext } from './transcript-context'

/**
 * 订上这段对话。
 *
 * @param conversationId - 哪一段对话。
 * @returns 时间线与读取状态，加一个重新加载的入口。
 */
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
