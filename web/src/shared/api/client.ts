/** REST 请求经同源 /api 代理并携带 HttpOnly 会话 cookie；响应须通过 zod 校验。OSS 直传与外链下载使用独立请求。 */

import type { z } from 'zod'

const API_BASE_PATH = '/api'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

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
  /** 请求失败或响应无法解析时的错误文案前缀。 */
  fallbackErrorMessage?: string
  /** 401 属于调用方的正常业务态（登录态探测、登录/登出/SSO 流程自身），不触发全局会话复核。 */
  skipUnauthorizedHandler?: boolean
}

export interface ApiFetchResult<T> {
  data: T
  response: Response
}

const readApiErrorMessage = async (response: Response, fallbackMessage: string) => {
  const responseText = await response.text().catch(() => '')
  const normalizedText = responseText.trim().toLowerCase()

  // 反代/网关的 HTML 错误页不外露给用户，只保留状态码。
  if (
    !responseText ||
    normalizedText.startsWith('<!doctype') ||
    normalizedText.startsWith('<html')
  ) {
    return `${fallbackMessage}（${response.status}）`
  }

  try {
    const parsed = JSON.parse(responseText) as {
      cause?: unknown
      detail?: unknown
      error?: unknown
      message?: unknown
    }
    const message =
      (typeof parsed.message === 'string' && parsed.message.trim()) ||
      (typeof parsed.cause === 'string' && parsed.cause.trim()) ||
      (typeof parsed.error === 'string' && parsed.error.trim()) ||
      (typeof parsed.detail === 'string' && parsed.detail.trim())

    return message ? `${fallbackMessage}：${message}` : `${fallbackMessage}（${response.status}）`
  } catch {
    return `${fallbackMessage}：${responseText}`
  }
}

/** path 不含 /api；URLSearchParams 按表单提交，其余 body 按 JSON。空正文按 undefined 校验；请求或校验失败抛错。 */
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

  const response = await fetch(`${API_BASE_PATH}${path}`, requestInit)

  if (!response.ok) {
    if (response.status === 401 && !skipUnauthorizedHandler) {
      onUnauthorized?.()
    }

    if (response.status === 403) {
      onForbidden?.()
    }

    throw new ApiError(response.status, await readApiErrorMessage(response, fallbackErrorMessage))
  }

  const responseText = await response.text()
  const payload: unknown = responseText.length > 0 ? JSON.parse(responseText) : undefined
  const parsed = schema.safeParse(payload)

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const location = issue && issue.path.length > 0 ? `（${issue.path.join('.')}）` : ''
    throw new Error(`${issue?.message ?? '响应格式无效'}${location}`)
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
