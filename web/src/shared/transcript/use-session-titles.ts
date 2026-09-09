/** 仅缓存连接期间收到的改名；缺失时使用基线标题。全局帧不补发，重连后清空缓存并依赖新基线。 */

import { use, useEffect, useState } from 'react'
import { TranscriptConnectionContext } from './transcript-context'

const EMPTY: ReadonlyMap<string, string> = new Map()

export const useSessionTitles = (): { titleOf: (conversationId: string) => string | undefined } => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useSessionTitles 要在 TranscriptProvider 里用')

  const [titles, setTitles] = useState(EMPTY)

  useEffect(
    () =>
      connection.watchSessions((update) => {
        if (update.kind === 'reconnected') {
          setTitles(EMPTY)
          return
        }
        if (update.kind !== 'title') return
        setTitles((current) =>
          current.get(update.conversationId) === update.title
            ? current
            : new Map(current).set(update.conversationId, update.title),
        )
      }),
    [connection],
  )

  return { titleOf: (conversationId: string) => titles.get(conversationId) }
}
