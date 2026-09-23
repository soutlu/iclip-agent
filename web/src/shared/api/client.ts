/** REST 请求经同源 /api 代理并携带 HttpOnly 会话 cookie；响应须通过 zod 校验。OSS 直传与外链下载使用独立请求。 */

import type { z } from 'zod'

const API_BASE_PATH = '/api'

/** message 是可直接展示给用户的中文，描述业务上可预期的失败（校验不过、直传失败、分镜已变化等）；程序不变量被破坏仍抛普通 Error。 */
export class UserFacingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserFacingError'
  }
}

/** apiFetch 除取消外的唯一失败形态：status 为 HTTP 状态码，断网或响应无法解析、校验不过时为 0，原始错误放在 cause。 */
export class ApiError extends UserFacingError {
  readonly status: number

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 取可展示的错误文案：UserFacingError（含 ApiError）用它的 message，其余一律用 fallback，不外露原始英文或技术信息。 */
export const errorMessageOf = (error: unknown, fallback: string): string =>
  error instanceof UserFacingError ? error.message : fallback

// 鉴权回调由 app 注入，避免 shared/api 反向依赖路由。
let onUnauthorized: (() => void) | null = null

export const setOnUnauthorized = (handler: (() => void) | null) => {
  onUnauthorized = handler
}

// 403 回调由 app 注入，用于刷新权限与路由守卫。
let onForbidden: (() => void) | null = null

export const setOnForbidden = (handler: (() => void) | null) => {
  onForbidden = handler
}

type ApiFetchOptions = Omit<RequestInit, 'body'> & {
  body?: unknown
  /** 一切失败的错误文案前缀：HTTP 错误、断网、响应无法解析或校验不过。 */
  fallbackErrorMessage?: string
  /** 401 属于调用方的正常业务态（登录态探测、登录/登出/SSO 流程自身），不触发全局会话复核。 */
  skipUnauthorizedHandler?: boolean
}

export interface ApiFetchResult<T> {
  data: T
  response: Response
}

/** 只认合同的 `{ detail: string }` 信封；其余正文（网关 HTML、纯文本、别的 JSON 形状）不外露，只保留状态码。 */
const readApiErrorMessage = async (response: Response, fallbackMessage: string) => {
  const responseText = await response.text().catch(() => '')
  let detail: unknown
  try {
    detail = (JSON.parse(responseText) as { detail?: unknown } | null)?.detail
  } catch {
    detail = undefined
  }
  const message = typeof detail === 'string' ? detail.trim() : ''
  return message ? `${fallbackMessage}：${message}` : `${fallbackMessage}（${response.status}）`
}

/** 断网时拼在调用方前缀后的文案；OSS 直传沿用同一句。 */
export const NETWORK_FAILURE = '网络连接失败，请检查网络后重试'
const MALFORMED_RESPONSE = '服务返回的数据格式不正确'

// 按 name 判断：中止可能来自另一个 realm 的 DOMException，instanceof 不可靠。
const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'

/** 取消不是失败：AbortError 原样抛出，交给 TanStack Query 与调用方的取消处理；其余包成 status 0 的 ApiError。 */
const asClientFailure = (error: unknown, message: string): unknown =>
  isAbortError(error) ? error : new ApiError(0, message, { cause: error })

/** path 不含 /api；URLSearchParams 按表单提交，其余 body 按 JSON。空正文按 undefined 校验；失败抛 {@link ApiError}，取消原样抛 AbortError。 */
export const apiFetchWithResponse = async <T>(
  path: string,
  schema: z.ZodType<T>,
  options: ApiFetchOptions = {},
): Promise<ApiFetchResult<T>> => {
  const {
    body,
    fallbackErrorMessage = '请求失败',
    headers,
    skipUnauthorizedHandler = false,
    ...rest
  } = options
  const requestInit: RequestInit = {
    credentials: 'same-origin',
    ...rest,
  }

  if (body instanceof URLSearchParams) {
    requestInit.body = body
    if (headers) {
      requestInit.headers = headers
    }
  } else if (body !== undefined) {
    requestInit.body = JSON.stringify(body)
    requestInit.headers = { 'Content-Type': 'application/json', ...headers }
  } else if (headers) {
    requestInit.headers = headers
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE_PATH}${path}`, requestInit)
  } catch (error) {
    throw asClientFailure(error, `${fallbackErrorMessage}：${NETWORK_FAILURE}`)
  }

  if (!response.ok) {
    if (response.status === 401 && !skipUnauthorizedHandler) {
      onUnauthorized?.()
    }

    if (response.status === 403) {
      onForbidden?.()
    }

    throw new ApiError(response.status, await readApiErrorMessage(response, fallbackErrorMessage))
  }

  let responseText: string
  try {
    responseText = await response.text()
  } catch (error) {
    throw asClientFailure(error, `${fallbackErrorMessage}：${NETWORK_FAILURE}`)
  }
  let payload: unknown
  try {
    payload = responseText.length > 0 ? JSON.parse(responseText) : undefined
  } catch (error) {
    throw new ApiError(0, `${fallbackErrorMessage}：${MALFORMED_RESPONSE}`, { cause: error })
  }
  const parsed = schema.safeParse(payload)

  if (!parsed.success) {
    throw new ApiError(0, `${fallbackErrorMessage}：${MALFORMED_RESPONSE}`, {
      cause: parsed.error,
    })
  }

  return {
    data: parsed.data,
    response,
  }
}

/** 需要状态码或响应头时使用 {@link apiFetchWithResponse}；两入口共用请求构造、鉴权回调与校验。 */
export const apiFetch = async <T>(
  path: string,
  schema: z.ZodType<T>,
  options: ApiFetchOptions = {},
): Promise<T> => (await apiFetchWithResponse(path, schema, options)).data
