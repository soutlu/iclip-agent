import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { server } from '@/testing/mocks/server'
import { ApiError, apiFetch, errorMessageOf, UserFacingError } from './client'

const FALLBACK = '读取示例失败'
const probeSchema = z.object({ title: z.string() })
const readProbe = () => apiFetch('/probe', probeSchema, { fallbackErrorMessage: FALLBACK })

/** 断言失败被包成可直接展示的 ApiError，返回它供进一步检查。 */
const rejectionOf = async (promise: Promise<unknown>): Promise<ApiError> => {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('apiFetch 失败形态', () => {
  it.each([
    {
      name: '响应不符合 schema',
      respond: () => HttpResponse.json({ title: 42 }),
      cause: z.ZodError,
    },
    {
      name: '成功响应的正文不是 JSON',
      respond: () => new HttpResponse('<html>ok</html>', { status: 200 }),
      cause: SyntaxError,
    },
    {
      name: '网络异常',
      respond: () => HttpResponse.error(),
      cause: TypeError,
    },
  ])(
    '$name 时抛 status 0 的 ApiError，文案以兜底开头、不含英文，原始错误留在 cause',
    async ({ respond, cause }) => {
      server.use(http.get('*/api/probe', respond))

      const error = await rejectionOf(readProbe())

      expect(error.status).toBe(0)
      expect(error.message.startsWith(`${FALLBACK}：`)).toBe(true)
      expect(error.message).not.toMatch(/[A-Za-z]/)
      expect(error.cause).toBeInstanceOf(cause)
    },
  )

  it.each([
    {
      name: '合同信封的 detail',
      respond: () => HttpResponse.json({ detail: '示例已被删除' }, { status: 404 }),
      status: 404,
      message: `${FALLBACK}：示例已被删除`,
    },
    {
      name: '合同外的键',
      respond: () => HttpResponse.json({ message: 'upstream exploded' }, { status: 500 }),
      status: 500,
      message: `${FALLBACK}（500）`,
    },
    {
      name: '非字符串的 detail',
      respond: () =>
        HttpResponse.json({ detail: [{ loc: ['body'], msg: 'field required' }] }, { status: 422 }),
      status: 422,
      message: `${FALLBACK}（422）`,
    },
    {
      name: '纯文本正文',
      respond: () => new HttpResponse('Bad Gateway: upstream timed out', { status: 502 }),
      status: 502,
      message: `${FALLBACK}（502）`,
    },
    {
      name: '网关 HTML 错误页',
      respond: () => new HttpResponse('<!doctype html><title>502</title>', { status: 502 }),
      status: 502,
      message: `${FALLBACK}（502）`,
    },
  ])('HTTP 失败遇到$name时保留状态码，文案为 $message', async ({ respond, status, message }) => {
    server.use(http.get('*/api/probe', respond))

    const error = await rejectionOf(readProbe())

    expect(error.status).toBe(status)
    expect(error.message).toBe(message)
  })
})

describe('errorMessageOf', () => {
  it.each([
    new ApiError(503, '读取示例失败：服务维护中'),
    new UserFacingError('读取示例失败：服务维护中'),
  ])('%s 取它自己的文案', (error) => {
    expect(errorMessageOf(error, FALLBACK)).toBe('读取示例失败：服务维护中')
  })

  it.each([
    new TypeError('Failed to fetch'),
    new Error('Invalid input: expected string'),
    'raw failure',
    { message: 'looks like an error' },
    undefined,
  ])('其他值一律回兜底文案：%s', (value) => {
    expect(errorMessageOf(value, FALLBACK)).toBe(FALLBACK)
  })
})
