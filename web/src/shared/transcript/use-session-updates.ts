/**
 * 对话身上那些「跟着服务端走」的东西：叫什么名字、此刻在忙什么。
 *
 * 两样都由全局帧推来（照 kimi），所以这里不订某一段对话——侧栏要的就是「任意一段变了」。
 *
 * **只记这条连接活着期间变过的那些。** 没变过的返回 `undefined`，调用方用自己那份（列表行或
 * 基线里的值）。行上本来就带着同一份事实，所以帧丢了不致命：断线重连时侧栏会重拉一次列表。
 */

import { use, useEffect, useState } from 'react'
import type { SessionUpdate } from './connection'
import { TranscriptConnectionContext } from './transcript-context'

/** 一段对话此刻在忙什么。与合同里 `ConversationOut.activity` 同一份事实。 */
export type ConversationActivity = {
  busy: boolean
  pendingInteraction: 'none' | 'approval' | 'question'
}

export type SessionUpdates = {
  /** 这段对话最新的标题；没收到过改名就是 `undefined`。 */
  titleOf: (conversationId: string) => string | undefined
  /** 这段对话最新的活儿；没收到过变化就是 `undefined`。 */
  activityOf: (conversationId: string) => ConversationActivity | undefined
}

type State = {
  titles: ReadonlyMap<string, string>
  activities: ReadonlyMap<string, ConversationActivity>
}

const EMPTY: State = { activities: new Map(), titles: new Map() }

/**
 * 订上全局帧。
 *
 * @param onReconnected - 断线重连之后调用一次：本地这两张表已经丢掉了，调用方该把列表重拉一遍。
 *   **必须是稳定的引用**（`useCallback`）：订阅挂在它上面，每渲一个新闭包就会退订重订一次。
 * @returns 按 id 查最新的标题与活儿。
 */
export const useSessionUpdates = (onReconnected?: () => void): SessionUpdates => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useSessionUpdates 要在 TranscriptProvider 里用')

  const [state, setState] = useState<State>(EMPTY)

  useEffect(
    () =>
      connection.watchSessions((update) => {
        setState((current) => next(current, update))
        if (update.kind === 'reconnected') onReconnected?.()
      }),
    [connection, onReconnected],
  )

  return {
    activityOf: (conversationId) => state.activities.get(conversationId),
    titleOf: (conversationId) => state.titles.get(conversationId),
  }
}

/** 叠一条更新。值没变就原样返回，省一次重渲。 */
const next = (current: State, update: SessionUpdate): State => {
  if (update.kind === 'reconnected') {
    // 断线期间的帧补不回来，本地这两张表已经不可信；丢掉，等重拉的列表把事实带回来。
    return EMPTY
  }
  if (update.kind === 'title') {
    if (current.titles.get(update.conversationId) === update.title) return current
    return { ...current, titles: new Map(current.titles).set(update.conversationId, update.title) }
  }
  const known = current.activities.get(update.conversationId)
  if (known?.busy === update.busy && known.pendingInteraction === update.pendingInteraction) {
    return current
  }
  return {
    ...current,
    activities: new Map(current.activities).set(update.conversationId, {
      busy: update.busy,
      pendingInteraction: update.pendingInteraction,
    }),
  }
}
