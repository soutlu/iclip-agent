/**
 * 对话叫什么名字跟着服务端走：自动起名与改名都由全局帧 `session.meta.updated` 推来（照 kimi），
 * 所以这里不订某一段对话。
 *
 * **只记这条连接活着期间改过的那些。** 没改过的返回 `undefined`，调用方用自己那份（基线里的
 * 标题）。断线期间的帧补不回来，重连时这张表整个丢掉，等重拉的基线把名字带回来。
 *
 * 侧栏那一侧不走这条路：它的行长在查询缓存里，帧到了就地改那一行（`useLiveConversations`）。
 */

import { use, useEffect, useState } from 'react'
import { TranscriptConnectionContext } from './transcript-context'

const EMPTY: ReadonlyMap<string, string> = new Map()

/**
 * 订上改名帧。
 *
 * @returns 按 id 查最新的标题；没收到过改名就是 `undefined`。
 */
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
