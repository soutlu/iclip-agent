import { HttpAgent } from '@ag-ui/client'
import {
  AssistantRuntimeProvider,
  type ExportedMessageRepository,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react'
import { useAgUiRuntime } from '@assistant-ui/react-ag-ui'
import type { ReadonlyJSONValue } from 'assistant-stream/utils'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { aguiTransportMiddleware, isAguiTransportInterruption } from './transport'

/** 注水用的历史：assistant-ui repository（由后端返回的 AG-UI 消息还原而来）。 */
export type AguiHistoryRepository = ExportedMessageRepository & {
  state?: ReadonlyJSONValue
  unstable_resume?: boolean
}

/** AG-UI CUSTOM 事件（结构化最小面，避免依赖 @ag-ui/core 内部类型）。 */
export interface AguiCustomEventPayload {
  name: string
  value: unknown
}

interface AguiConversationRuntimeProviderProps {
  children: ReactNode
  /** 对话 id：服务端发放，就是 AG-UI 的 `threadId`。 */
  conversationId: string
  /** 读这段对话的历史，还原成 repository。 */
  loadHistory: (conversationId: string) => Promise<AguiHistoryRepository>
  /** CUSTOM 事件消费；省略即忽略。 */
  onCustomEvent?: (event: AguiCustomEventPayload) => void
  onRuntimeError: (error: Error) => void
  /** 运行端点（含 `/api` 前缀的完整同源 URL）。 */
  runUrl: string
  showThinking: boolean
}

interface AguiConnectionContextValue {
  historyLoaded: boolean
}

const AguiConnectionContext = createContext<AguiConnectionContextValue | null>(null)

/** 历史是否已注水完成（首条消息要等它之后再发）。 */
export const useAguiConnection = () => {
  const connection = useContext(AguiConnectionContext)

  if (!connection) {
    throw new Error('useAguiConnection 必须在 AguiConversationRuntimeProvider 内使用。')
  }

  return connection
}

const TRANSPORT_INTERRUPTED_MESSAGE =
  '连接断开了。后端会继续把这次运行跑完并落库，刷新页面可查看已存档的结果。'

/**
 * 为一段对话提供唯一的官方 AG-UI runtime。
 *
 * 原厂 `HttpAgent` 单 URL（`POST /agents/{agentId}/chat`），历史经官方
 * `ThreadHistoryAdapter` 从后端读回。断线只是没人读了：运行在后端照跑、照落库，
 * 所以这里不自动重发——再发一次是开新运行。
 */
export default function AguiConversationRuntimeProvider({
  children,
  conversationId,
  loadHistory,
  onCustomEvent,
  onRuntimeError,
  runUrl,
  showThinking,
}: AguiConversationRuntimeProviderProps) {
  const [historyLoaded, setHistoryLoaded] = useState(false)

  const agent = useMemo(() => {
    const created = new HttpAgent({ threadId: conversationId, url: runUrl })
    created.use(aguiTransportMiddleware(conversationId))
    return created
  }, [conversationId, runUrl])

  const history = useMemo<ThreadHistoryAdapter>(
    () => ({
      // 消息由后端在运行中落库；这里只负责读回来。
      append: () => Promise.resolve(undefined),
      load: async () => {
        const repository = await loadHistory(conversationId)
        setHistoryLoaded(true)
        return repository
      },
    }),
    [conversationId, loadHistory],
  )

  const handleRuntimeError = useCallback(
    (error: Error) => {
      if (isAguiTransportInterruption(error)) {
        onRuntimeError(new Error(TRANSPORT_INTERRUPTED_MESSAGE, { cause: error }))
        return
      }
      onRuntimeError(error)
    },
    [onRuntimeError],
  )

  const runtime = useAgUiRuntime({
    adapters: {
      history,
    },
    agent,
    onError: handleRuntimeError,
    showThinking,
  })

  useEffect(() => {
    if (!onCustomEvent) {
      return
    }
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        onCustomEvent({ name: event.name, value: event.value })
      },
    })

    return () => subscription.unsubscribe()
  }, [agent, onCustomEvent])

  // 卸载时中止在途 SSE run。React 会在并未卸载组件的情况下执行同样的
  // cleanup（StrictMode 开发期双调用、Suspense/Offscreen 隐藏后重连都会
  // 「断开再重连」effect），直接 abort 会误杀活跃流。因此把 abort 推迟到
  // 宏任务：随即重连的 setup 会取消它，只有真正卸载（无重连）才执行。
  const pendingAbortTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (pendingAbortTimerRef.current !== null) {
      window.clearTimeout(pendingAbortTimerRef.current)
      pendingAbortTimerRef.current = null
    }
    return () => {
      pendingAbortTimerRef.current = window.setTimeout(() => {
        pendingAbortTimerRef.current = null
        agent.abortRun()
      }, 0)
    }
  }, [agent])

  const connectionValue = useMemo<AguiConnectionContextValue>(
    () => ({ historyLoaded }),
    [historyLoaded],
  )

  return (
    <AguiConnectionContext.Provider value={connectionValue}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </AguiConnectionContext.Provider>
  )
}
