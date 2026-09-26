import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { addMockTask } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { fetchTasksPage, listTasksByIds } from './tasks.api'

describe('fetchTasksPage', () => {
  const CURSOR = '2026-09-01T00:00:00+00:00|abc'

  it.each([
    { scope: 'all', cursor: null, expected: { limit: '100' } },
    { scope: 'mine', cursor: null, expected: { claimedBy: 'me', limit: '100' } },
    { scope: 'all', cursor: CURSOR, expected: { cursor: CURSOR, limit: '100' } },
  ] as const)(
    '$scope 一页取满上限，我的由服务端按会话筛，游标原样回传（$cursor）',
    async ({ scope, cursor, expected }) => {
      const task = addMockTask('夏季系列短片')
      let requestUrl: URL | undefined
      server.use(
        http.get('*/api/tasks', ({ request }) => {
          requestUrl = new URL(request.url)
          return HttpResponse.json({ items: [task], nextCursor: null, total: 1 })
        }),
      )

      const page = await fetchTasksPage(scope, cursor)

      expect(page.items).toEqual([task])
      expect(page.total).toBe(1)
      expect(Object.fromEntries(requestUrl?.searchParams ?? [])).toEqual(expected)
    },
  )

  it('取消查询时中断正在读取的请求', async () => {
    let pendingRequest: Request | undefined
    server.use(
      http.get('*/api/tasks', async ({ request }) => {
        pendingRequest = request
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return HttpResponse.json({ items: [], nextCursor: null, total: 0 })
      }),
    )

    const controller = new AbortController()
    const response = fetchTasksPage('all', null, controller.signal)
    const rejection = expect(response).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(pendingRequest).toBeDefined())
    controller.abort()

    await rejection
    expect(pendingRequest?.signal.aborted).toBe(true)
  })
})

describe('listTasksByIds', () => {
  it('按 id 批量读取，一批的 limit 就是 id 个数，返回响应里的需求单', async () => {
    const task = addMockTask('要读的需求')
    const ids = [task.id, crypto.randomUUID()]
    let requestUrl: URL | undefined
    server.use(
      http.get('*/api/tasks', ({ request }) => {
        requestUrl = new URL(request.url)
        return HttpResponse.json({ items: [task], nextCursor: null, total: 1 })
      }),
    )

    const found = await listTasksByIds(ids)

    expect(requestUrl?.searchParams.getAll('ids')).toEqual(ids)
    expect(requestUrl?.searchParams.get('limit')).toBe(String(ids.length))
    expect(found).toEqual([task])
  })
})
