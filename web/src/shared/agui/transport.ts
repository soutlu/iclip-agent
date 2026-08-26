import {
  type BaseEvent,
  EventType,
  type MiddlewareFunction,
  type RunAgentInput,
} from '@ag-ui/client'
import { catchError, concatWith, defer, EMPTY, filter, NEVER, tap, throwError } from 'rxjs'
import { isRecord } from '@/shared/lib/guards'

/** 标识真实传输中断的错误类型：网络断了，或流在终止事件之前就结束了。 */
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
 * 契约：不展示给用户，也不视作合法终止。
 */
const LOCAL_ABORT_RUN_ERROR_CODE = 'abort'

const isLocalAbortRunError = (event: BaseEvent) =>
  event.type === EventType.RUN_ERROR && isRecord(event) && event.code === LOCAL_ABORT_RUN_ERROR_CODE

/** 浏览器 fetch/ReadableStream 的真实断网错误；HTTP 与协议错误不属于此类。 */
export const isAguiTransportInterruption = (error: unknown) =>
  error instanceof AguiTransportInterruptionError ||
  error instanceof TypeError ||
  errorName(error) === 'NetworkError'

const normalizeAguiRunInput = (input: RunAgentInput, conversationId: string): RunAgentInput => {
  const forwardedProps: Record<string, unknown> = isRecord(input.forwardedProps)
    ? { ...input.forwardedProps }
    : {}

  delete forwardedProps.background
  delete forwardedProps.runConfig

  return {
    ...input,
    forwardedProps,
    threadId: conversationId,
  }
}

/**
 * 传输层 middleware（官方公开 `agent.use` 扩展点）。
 *
 * 只做两件事，不合成、过滤或重试任何 AG-UI 事件：
 * - 规范出站 input（剥离 adapter 注入的 background/runConfig，钉死 threadId）；
 * - 把真实断网与「无终止事件的提前 EOF」统一收敛为
 *   {@link AguiTransportInterruptionError} 抛给 runtime `onError`。
 *   错误通道的 AbortError 保持静默；`@ag-ui/client` 合成的带内
 *   `RUN_ERROR(code='abort')` 不展示原文，也不算合法终止，同样收敛为传输中断。
 *
 * 断了之后这里**不重发**：后端的运行不绑在这次请求上，会自己跑完并落库；再 POST 一次
 * 是开一次新运行，不是接上原来那条。
 *
 * @param conversationId - 当前对话 id，同时作为 AG-UI threadId。
 * @returns 官方 middleware 函数。
 */
export const aguiTransportMiddleware =
  (conversationId: string): MiddlewareFunction =>
  (input, next) => {
    let terminalSeen = false

    return next.run(normalizeAguiRunInput(input, conversationId)).pipe(
      tap((event) => {
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
