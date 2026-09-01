/**
 * 标题跟着服务端走：一段对话被自动起名或者被改名，界面上那几处名字当场跟着变。
 *
 * 服务端起完名会发一帧全局的 `session.meta.updated`（照 kimi），所以这里不订某一段对话——
 * 侧栏要的就是「任意一段改了名」。
 */

import { use, useEffect, useState } from 'react'
import { TranscriptConnectionContext } from './transcript-context'

/**
 * 订上改名推送，给出「这段对话现在叫什么」的查询函数。
 *
 * 只记这条连接活着期间改过名的那些；没改过的返回 `undefined`，调用方用自己那份（列表或基线
 * 里的标题）。这样就不必把整份列表搬到这里来。
 *
 * @returns 按 id 查最新标题；没收到过改名就是 `undefined`。
 */
export const useConversationTitles = (): ((conversationId: string) => string | undefined) => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useConversationTitles 要在 TranscriptProvider 里用')

  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map())

  useEffect(
    () =>
      connection.watchMeta(({ session_id, title }) => {
        setTitles((current) => {
          if (current.get(session_id) === title) return current
          return new Map(current).set(session_id, title)
        })
      }),
    [connection],
  )

  return (conversationId) => titles.get(conversationId)
}
