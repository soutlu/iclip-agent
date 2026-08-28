/**
 * 同源 API 请求客户端。
 *
 * 所有请求经 `/api` 前缀走同源代理直达后端（dev: vite proxy；prod: 反代），
 * 会话 HttpOnly cookie 由浏览器自动携带。所有响应在边界处经 zod schema
 * 校验后才交给业务代码。
 *
 * 后端 REST 接口一律走 apiFetch；仅两类请求允许裸 fetch：OSS 预签名直传 PUT、
 * 外链素材下载（均不是后端 JSON REST）。
 */

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

// 会话疑似失效（401）的全局处理由 app 层注入（强刷 /users/me + 重算路由），shared/api 不反向依赖 router。
let onUnauthorized: (() => void) | null = null

/**
 * 注入接口 401 时的全局回调。
 *
 * @param handler - 会话失效时执行的回调；传 null 取消注入。
 */
export const setOnUnauthorized = (handler: (() => void) | null) => {
  onUnauthorized = handler
}

// 权限不足（403）的全局处理由 app 层注入（刷新用户缓存 + 重算路由守卫），shared/api 不反向依赖 router。
let onForbidden: (() => void) | null = null

/**
 * 注入接口 403 时的全局回调。
 *
 * @param handler - 权限不足时执行的回调；传 null 取消注入。
 */
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

/**
 * 从后端错误响应中提取可展示的错误文案。
 *
 * @param response - fetch 返回的非成功响应。
 * @param fallbackMessage - 错误文案前缀。
 * @returns 可直接展示给用户的错误文案（`前缀：后端信息` 或 `前缀（状态码）`）。
 */
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

/**
 * 发起同源后端请求，统一处理错误并在边界处校验响应。
 *
 * body 传 URLSearchParams 时按表单提交（登录是 OAuth2 表单），其余序列化为 JSON；
 * 204/空响应体在校验前解析为 undefined（schema 用 z.unknown() 表示忽略响应体）。
 *
 * @param path - 不含 `/api` 前缀的后端路径（如 `/users/me`）。
 * @param schema - 响应体的 zod schema，解析结果即返回值。
 * @param options - fetch 配置与错误处理选项。
 * @returns schema 校验后的响应数据及原始响应元信息。
 * @throws 非成功响应抛出带状态码的 ApiError；响应不符合 schema 时抛出首条校验错误。
 */
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

/**
 * 发起同源后端请求，并只返回通过 schema 校验的响应数据。
 *
 * 需要读取状态码或响应头的调用方应使用 {@link apiFetchWithResponse}；两种入口共享
 * 同一套请求构造、鉴权通知、错误处理和响应校验。
 *
 * @param path - 不含 `/api` 前缀的后端路径。
 * @param schema - 响应体的 zod schema。
 * @param options - fetch 配置与错误处理选项。
 * @returns schema 校验后的响应数据。
 */
export const apiFetch = async <T>(
  path: string,
  schema: z.ZodType<T>,
  options: ApiFetchOptions = {},
): Promise<T> => (await apiFetchWithResponse(path, schema, options)).data
