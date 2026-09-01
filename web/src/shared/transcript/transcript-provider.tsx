/**
 * 挂上订阅连接。一个标签页只开一条 WebSocket，侧栏与会话页各自订自己那段对话。
 */

import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { TranscriptConnection } from './connection'
import { TranscriptConnectionContext } from './transcript-context'

/** 同源反代把 `/api` 后面的路径转给后端，WebSocket 也走这一条（vite 代理已开 `ws`）。 */
const transcriptUrl = () =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws`

type TranscriptProviderProps = {
  children: ReactNode
  /** 测试用：换掉 WebSocket 实现。 */
  createSocket?: ((url: string) => WebSocket) | undefined
}

/**
 * 建连并把它交给子树。
 *
 * @param props - Provider 属性。
 * @param props.children - 子树。
 * @param props.createSocket - 测试用的 WebSocket 工厂。
 * @returns Provider。
 */
export function TranscriptProvider({ children, createSocket }: TranscriptProviderProps) {
  const connection = useMemo(
    () =>
      new TranscriptConnection({
        url: transcriptUrl(),
        ...(createSocket === undefined ? {} : { createSocket }),
      }),
    [createSocket],
  )

  useEffect(() => {
    connection.connect()

    // 标签页在后台待久了，那条连接多半已经僵着——浏览器不一定派 close，退避也可能还排在
    // 几十秒之后。所以重新露面时先问一句「还活着吗」，僵了就立刻重连（照 kimi 网页版：
    // visibilitychange / focus / online 三个事件绑同一个处理器）。
    const reviveIfStale = () => {
      if (document.visibilityState === 'hidden') return
      if (connection.health().stale) connection.reconnect()
    }
    document.addEventListener('visibilitychange', reviveIfStale)
    window.addEventListener('focus', reviveIfStale)
    window.addEventListener('online', reviveIfStale)

    return () => {
      document.removeEventListener('visibilitychange', reviveIfStale)
      window.removeEventListener('focus', reviveIfStale)
      window.removeEventListener('online', reviveIfStale)
      connection.close()
    }
  }, [connection])

  return <TranscriptConnectionContext value={connection}>{children}</TranscriptConnectionContext>
}
