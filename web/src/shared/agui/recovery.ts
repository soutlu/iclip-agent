import {
  type BaseEvent,
  EventType,
  type MiddlewareFunction,
  type RunAgentInput,
} from '@ag-ui/client'
import { catchError, concatWith, defer, EMPTY, filter, NEVER, tap, throwError } from 'rxjs'
import { isRecord } from '@/shared/lib/guards'

/** 后端 RUN_ERROR 错误码全集（wire 契约，iclip_agent ADR-0005）。 */
export const AGUI_RUN_ERROR_CODES = {
  activeElsewhere: 'ACTIVE_ELSEWHERE',
  cancelled: 'CANCELLED',
  runInProgress: 'RUN_IN_PROGRESS',
} as const

/** 自动重连的尝试上限，超过后进入 degraded 等待手动重试。 */
export const AGUI_RECONNECT_MAX_ATTEMPTS = 5

const BASE_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 30_000
const RETRY_JITTER_MS = 250

/**
 * 连接恢复状态机（可辨识联合）。
 *
 * - `idle`：无进行中 run。
 * - `streaming`：run 事件流进行中。
 * - `interrupted`：传输中断或 ACTIVE_ELSEWHERE，等待退避后重发 startRun。
 * - `degraded`：自动重试耗尽，等待手动重试。
 */
export type AguiConnectionState =
  | { phase: 'idle' }
  | { phase: 'streaming' }
  | { attempt: number; phase: 'interrupted' }
  | { phase: 'degraded' }

export type AguiConnectionEvent =
  | { type: 'runStarted' }
  | { type: 'runSettled' }
  | { type: 'interrupted' }
  | { type: 'manualRetry' }

export const initialAguiConnectionState: AguiConnectionState = { phase: 'idle' }

/**
 * 连接状态机的唯一迁移函数。
 *
 * @param state - 当前连接状态。
 * @param event - 连接事件。
 * @returns 迁移后的连接状态。
 */
export const reduceAguiConnection = (
  state: AguiConnectionState,
  event: AguiConnectionEvent,
): AguiConnectionState => {
  switch (event.type) {
    case 'runStarted':
      // attach 重试开始不代表连接已经恢复；保留 attempt，直到真实终态收敛。
      return state.phase === 'interrupted' ? state : { phase: 'streaming' }
    case 'runSettled':
      return { phase: 'idle' }
    case 'interrupted': {
      const attempt = state.phase === 'interrupted' ? state.attempt + 1 : 1
      if (attempt > AGUI_RECONNECT_MAX_ATTEMPTS) {
        return { phase: 'degraded' }
      }
      return { attempt, phase: 'interrupted' }
    }
    case 'manualRetry':
      return state.phase === 'degraded' ? { attempt: 1, phase: 'interrupted' } : state
  }
}

/**
 * 指数退避 + 抖动的重试延迟。
 *
 * @param attempt - 第几次重试（从 1 起）。
 * @returns 毫秒延迟。
 */
export const aguiRetryDelayMs = (attempt: number) => {
  const exponential = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(exponential, MAX_RETRY_DELAY_MS) + Math.floor(Math.random() * RETRY_JITTER_MS)
}

/** 标识真实传输中断的错误类型（provider 据此走重连而非报错）。 */
export class AguiTransportInterruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AguiTransportInterruptionError'
  }
}

const errorName = (error: unknown) =>
  typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : null

const isAbortError = (error: unknown) => errorName(error) === 'AbortError'

/**
 * `@ag-ui/client` 在 fetch 被本地 abort 时不让流报错，而是合成带内
 * `RUN_ERROR(code='abort')`（message 为浏览器原文，如 Chrome 的
 * "BodyStreamBuffer was aborted"）。它是纯客户端产物、不属于后端 wire
 * 契约：不展示给用户，也不视作合法终止——按传输中断交给恢复状态机。
 */
const LOCAL_ABORT_RUN_ERROR_CODE = 'abort'

export const isLocalAbortRunError = (event: BaseEvent) =>
  event.type === EventType.RUN_ERROR && isRecord(event) && event.code === LOCAL_ABORT_RUN_ERROR_CODE

/** 浏览器 fetch/ReadableStream 的真实断网错误；HTTP 与协议错误不属于此类。 */
export const isAguiTransportInterruption = (error: unknown) =>
  error instanceof AguiTransportInterruptionError ||
  error instanceof TypeError ||
  errorName(error) === 'NetworkError'

const normalizeAguiRunInput = (input: RunAgentInput, sessionId: string): RunAgentInput => {
  const forwardedProps: Record<string, unknown> = isRecord(input.forwardedProps)
    ? { ...input.forwardedProps }
    : {}

  delete forwardedProps.background
  delete forwardedProps.runConfig

  return {
    ...input,
    forwardedProps,
    threadId: sessionId,
  }
}

/**
 * 传输层错误归一 middleware（官方公开 `agent.use` 扩展点）。
 *
 * 只做两件事，不合成、过滤或重试任何 AG-UI 事件：
 * - 规范出站 input（剥离 adapter 注入的 background/runConfig，钉死 threadId）；
 * - 把真实断网与「无终止事件的提前 EOF」统一收敛为
 *   {@link AguiTransportInterruptionError} 抛给 runtime `onError`，
 *   由 recovery 状态机走退避重连。错误通道的 AbortError 保持静默；
 *   `@ag-ui/client` 合成的带内 `RUN_ERROR(code='abort')` 不展示原文，
 *   也不算合法终止，同样收敛为传输中断走重连。
 *
 * @param sessionId - 当前 Agno session id，同时作为 AG-UI threadId。
 * @returns 官方 middleware 函数。
 */
export const aguiTransportMiddleware =
  (sessionId: string): MiddlewareFunction =>
  (input, next) => {
    let terminalSeen = false

    return next.run(normalizeAguiRunInput(input, sessionId)).pipe(
      tap((event) => {
        // 本地 abort 合成的 RUN_ERROR 不算合法终止：吞掉事件后流以「无终止
        // 事件的 EOF」收场，走下方传输中断分支（provider 已卸载时是无害
        // 空操作；仍挂载时触发退避重连，由后端归因 attach 续流）。
        if (isLocalAbortRunError(event)) {
          return
        }
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          terminalSeen = true
        }
      }),
      filter((event) => !isLocalAbortRunError(event)),
      catchError((error: unknown) => {
        if (isAbortError(error)) {
          return NEVER
        }
        if (isAguiTransportInterruption(error)) {
          return throwError(
            () =>
              new AguiTransportInterruptionError('AG-UI transport interrupted.', {
                cause: error,
              }),
          )
        }
        return throwError(() => error)
      }),
      concatWith(
        defer(() => {
          if (terminalSeen) {
            return EMPTY
          }

          return throwError(
            () => new AguiTransportInterruptionError('AG-UI stream ended before a terminal event.'),
          )
        }),
      ),
    )
  }

/**
 * 读取 RUN_ERROR 事件的契约错误码。
 *
 * @param event - AG-UI RUN_ERROR 事件对象。
 * @returns 契约错误码；无 code 或非契约码时返回 null。
 */
export const aguiRunErrorCode = (event: unknown) => {
  if (!isRecord(event) || typeof event.code !== 'string') {
    return null
  }
  const codes: readonly string[] = Object.values(AGUI_RUN_ERROR_CODES)
  return codes.includes(event.code) ? event.code : null
}
