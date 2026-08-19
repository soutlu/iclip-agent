import { HttpAgent } from '@ag-ui/client'
import {
  AssistantRuntimeProvider,
  type ExportedMessageRepository,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react'
import { useAgUiRuntime } from '@assistant-ui/react-ag-ui'
import type { ReadonlyJSONValue } from 'assistant-stream/utils'
import type { ReactNode } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import {
  AGUI_RUN_ERROR_CODES,
  type AguiConnectionState,
  aguiRetryDelayMs,
  aguiRunErrorCode,
  aguiTransportMiddleware,
  initialAguiConnectionState,
  isAguiTransportInterruption,
  reduceAguiConnection,
} from './recovery'

/** restore 响应中的后端恢复决策：唯一可 attach 的在途 run。 */
export interface AguiActiveRun {
  runId: string
}

/** restore 注水结果：assistant-ui repository + 后端 activeRun 决策。 */
export interface AguiRestoreHistory {
  activeRun: AguiActiveRun | null
  repository: ExportedMessageRepository & {
    state?: ReadonlyJSONValue
    unstable_resume?: boolean
  }
}

/** AG-UI CUSTOM 事件（结构化最小面，避免依赖 @ag-ui/core 内部类型）。 */
export interface AguiCustomEventPayload {
  name: string
  value: unknown
}

interface AguiSessionRuntimeProviderProps {
  children: ReactNode
  /** target 专属的 restore 加载器；返回 repository 与 activeRun 决策。 */
  loadHistory: (sessionId: string) => Promise<AguiRestoreHistory>
  /** target 专属的 CUSTOM 事件消费（如 team 成员事件）；省略即忽略。 */
  onCustomEvent?: (event: AguiCustomEventPayload) => void
  onRuntimeError: (error: Error) => void
  /** run 端点（即 target path 本身，含 `/api` 前缀）。 */
  runUrl: string
  sessionId: string
  showThinking: boolean
}

interface AguiConnectionContextValue {
  historyLoaded: boolean
  retry: () => void
  state: AguiConnectionState
}

const AguiConnectionContext = createContext<AguiConnectionContextValue | null>(null)

/** 读取连接恢复状态与手动重试入口（重连期间禁写、degraded 横幅用）。 */
export const useAguiConnection = () => {
  const connection = useContext(AguiConnectionContext)

  if (!connection) {
    throw new Error('useAguiConnection 必须在 AguiSessionRuntimeProvider 内使用。')
  }

  return connection
}

/**
 * 为一个 session 提供唯一的官方 AG-UI runtime（target 无关的通用装配）。
 *
 * 结构遵循 iclip_agent ADR-0005：原厂 `HttpAgent` 单 URL；restore 注水与
 * `activeRun` 决策来自官方 `ThreadHistoryAdapter`；断线重连退化为「退避后
 * 再触发一次普通 startRun」——是新 run、attach 桥接还是快照兜底由后端归因，
 * 前端不做任何路由决策，也没有 runtime 换代。
 */
export default function AguiSessionRuntimeProvider({
  children,
  loadHistory,
  onCustomEvent,
  onRuntimeError,
  runUrl,
  sessionId,
  showThinking,
}: AguiSessionRuntimeProviderProps) {
  const [connection, dispatch] = useReducer(reduceAguiConnection, initialAguiConnectionState)
  const pendingAttachRef = useRef<AguiActiveRun | null>(null)
  const lastRunErrorCodeRef = useRef<string | null>(null)
  const [attachTick, setAttachTick] = useState(0)
  const [historyLoaded, setHistoryLoaded] = useState(false)

  const agent = useMemo(() => {
    const created = new HttpAgent({ threadId: sessionId, url: runUrl })
    created.use(aguiTransportMiddleware(sessionId))
    return created
  }, [runUrl, sessionId])

  const history = useMemo<ThreadHistoryAdapter>(
    () => ({
      // 消息由 AG-UI run 写入后端 Session；history adapter 只负责官方 restore 读取。
      append: () => Promise.resolve(undefined),
      load: async () => {
        const restored = await loadHistory(sessionId)
        pendingAttachRef.current = restored.activeRun
        if (restored.activeRun) {
          setAttachTick((tick) => tick + 1)
        }
        setHistoryLoaded(true)
        return restored.repository
      },
    }),
    [loadHistory, sessionId],
  )

  const handleRuntimeError = useCallback(
    (error: Error) => {
      if (isAguiTransportInterruption(error)) {
        dispatch({ type: 'interrupted' })
        return
      }
      const code = lastRunErrorCodeRef.current
      if (
        code === AGUI_RUN_ERROR_CODES.activeElsewhere ||
        code === AGUI_RUN_ERROR_CODES.cancelled
      ) {
        // ACTIVE_ELSEWHERE 已由订阅回调转入重连；CANCELLED 是中性终态。
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

  const startRecoveryRun = useCallback(() => {
    const thread = runtime.thread.getState()
    if (thread.isLoading || thread.isRunning) {
      return false
    }
    runtime.thread.startRun({
      parentId: thread.messages.at(-1)?.id ?? null,
    })
    return true
  }, [runtime])

  // restore 报告 activeRun：注水完成后自动触发一次 startRun（后端归因为 attach）。
  useEffect(() => {
    if (attachTick === 0) {
      return
    }

    const startWhenHydrated = () => {
      if (pendingAttachRef.current === null) {
        return
      }
      const thread = runtime.thread.getState()
      if (thread.isLoading || thread.isRunning) {
        return
      }
      pendingAttachRef.current = null
      runtime.thread.startRun({
        parentId: thread.messages.at(-1)?.id ?? null,
      })
    }

    startWhenHydrated()
    return runtime.thread.subscribe(startWhenHydrated)
  }, [attachTick, runtime])

  // 传输中断 / ACTIVE_ELSEWHERE：指数退避后重发普通 startRun，离线时等待网络恢复。
  useEffect(() => {
    if (connection.phase !== 'interrupted') {
      return
    }

    let timer: number | null = null
    let onlineListener: (() => void) | null = null

    const fire = () => {
      timer = window.setTimeout(() => {
        timer = null
        startRecoveryRun()
      }, aguiRetryDelayMs(connection.attempt))
    }

    if (navigator.onLine) {
      fire()
    } else {
      onlineListener = fire
      window.addEventListener('online', onlineListener, { once: true })
    }

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer)
      }
      if (onlineListener) {
        window.removeEventListener('online', onlineListener)
      }
    }
  }, [connection, startRecoveryRun])

  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        onCustomEvent?.({ name: event.name, value: event.value })
      },
      onRunErrorEvent: ({ event }) => {
        const code = aguiRunErrorCode(event)
        lastRunErrorCodeRef.current = code
        if (code === AGUI_RUN_ERROR_CODES.activeElsewhere) {
          dispatch({ type: 'interrupted' })
          return
        }
        dispatch({ type: 'runSettled' })
      },
      onRunFinishedEvent: () => {
        lastRunErrorCodeRef.current = null
        dispatch({ type: 'runSettled' })
      },
      onRunStartedEvent: () => {
        lastRunErrorCodeRef.current = null
        dispatch({ type: 'runStarted' })
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
    () => ({
      historyLoaded,
      retry: () => {
        dispatch({ type: 'manualRetry' })
      },
      state: connection,
    }),
    [connection, historyLoaded],
  )

  return (
    <AguiConnectionContext.Provider value={connectionValue}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </AguiConnectionContext.Provider>
  )
}
