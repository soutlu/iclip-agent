import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { addMockConversation } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { fetchTaskConversations } from './task-conversations.api'

const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const signal = () => new AbortController().signal

describe('fetchTaskConversations', () => {
  it('普通用户走需求单关联接口，保留服务端顺序，不查询审计接口', async () => {
    const first = addMockConversation('先返回的对话', '2026-09-20T00:00:00Z')
    const second = addMockConversation('后返回的对话', '2026-09-21T00:00:00Z')
    const paths: string[] = []
    server.use(
      http.get('*/api/conversations/by-task/:taskId', ({ request, params }) => {
        paths.push(new URL(request.url).pathname)
        expect(params['taskId']).toBe(TASK_ID)
        return HttpResponse.json({ items: [first, second] })
      }),
      http.get('*/api/conversations/audit', ({ request }) => {
        paths.push(new URL(request.url).pathname)
        return HttpResponse.json({ detail: '禁止审计' }, { status: 403 })
      }),
    )

    await expect(fetchTaskConversations(TASK_ID, false, signal())).resolves.toEqual([first, second])
    expect(paths).toEqual([`/api/conversations/by-task/${TASK_ID}`])
  })

  it('治理者按需求单过滤未删除对话，逐页取完并保持每页原有顺序', async () => {
    const first = addMockConversation('第一页')
    const second = addMockConversation('第二页')
    const requests: URLSearchParams[] = []
    const nextCursor = 'next/page+2='
    server.use(
      http.get('*/api/conversations/audit', ({ request }) => {
        const params = new URL(request.url).searchParams
        requests.push(params)
        return HttpResponse.json({
          items: [params.has('cursor') ? second : first],
          nextCursor: params.has('cursor') ? null : nextCursor,
          total: 2,
          runningTotal: 0,
        })
      }),
    )

    await expect(fetchTaskConversations(TASK_ID, true, signal())).resolves.toEqual([first, second])
    expect(requests.map((params) => Object.fromEntries(params))).toEqual([
      { taskId: TASK_ID, deleted: 'live', limit: '100' },
      { taskId: TASK_ID, deleted: 'live', limit: '100', cursor: nextCursor },
    ])
  })

  it.each([false, true])('canAudit=%s 时权限失败直接抛出，不切换读取范围', async (canAudit) => {
    const paths: string[] = []
    server.use(
      http.get('*/api/conversations/*', ({ request }) => {
        paths.push(new URL(request.url).pathname)
        return HttpResponse.json({ detail: '权限不足' }, { status: 403 })
      }),
    )

    await expect(fetchTaskConversations(TASK_ID, canAudit, signal())).rejects.toMatchObject({
      message: '读取关联对话失败：权限不足',
      status: 403,
    })
    expect(paths).toEqual([
      canAudit ? '/api/conversations/audit' : `/api/conversations/by-task/${TASK_ID}`,
    ])
  })

  it('治理者后续分页失败时抛出错误，不把第一页当成完整结果', async () => {
    const first = addMockConversation('第一页')
    server.use(
      http.get('*/api/conversations/audit', ({ request }) => {
        if (new URL(request.url).searchParams.has('cursor')) {
          return HttpResponse.json({ detail: '读取失败' }, { status: 503 })
        }
        return HttpResponse.json({
          items: [first],
          nextCursor: 'page-2',
          total: 2,
          runningTotal: 0,
        })
      }),
    )

    await expect(fetchTaskConversations(TASK_ID, true, signal())).rejects.toMatchObject({
      status: 503,
    })
  })

  it.each([false, true])('canAudit=%s 时取消查询会中断正在读取的请求', async (canAudit) => {
    let pendingRequest: Request | undefined
    server.use(
      http.get('*/api/conversations/*', async ({ request }) => {
        pendingRequest = request
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return HttpResponse.json({ items: [], nextCursor: null, total: 0, runningTotal: 0 })
      }),
    )

    const controller = new AbortController()
    const response = fetchTaskConversations(TASK_ID, canAudit, controller.signal)
    const rejection = expect(response).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(pendingRequest).toBeDefined())
    controller.abort()

    await rejection
    expect(pendingRequest?.signal.aborted).toBe(true)
  })
})
