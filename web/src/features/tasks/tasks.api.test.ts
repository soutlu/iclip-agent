import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { addMockTask, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { claimTask, fetchTasksPage, listTasksByIds } from './tasks.api'

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

  it('读取失败时抛出服务错误，供列表展示和重试', async () => {
    server.use(
      http.get('*/api/tasks', () =>
        HttpResponse.json({ detail: '需求单服务暂不可用' }, { status: 503 }),
      ),
    )

    await expect(fetchTasksPage('all', null)).rejects.toThrow(
      '读取需求单列表失败：需求单服务暂不可用',
    )
  })

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
  it('按 id 批量读取，一批的 limit 就是 id 个数，库里没有的不回', async () => {
    const wanted = addMockTask('要读的需求')
    addMockTask('无关的需求')

    const found = await listTasksByIds([wanted.id, crypto.randomUUID()])

    expect(found).toEqual([wanted])
  })
})

describe('mock 需求单认领身份', () => {
  it('治理者认领后在自己的需求单中可见，重复认领不会添加其他用户', async () => {
    const task = addMockTask('治理者认领的需求')
    task.status = 'published'
    await apiFetch('/auth/login', z.unknown(), {
      method: 'POST',
      body: new URLSearchParams({ username: 'governor', password: 'mock' }),
      fallbackErrorMessage: '模拟登录失败',
    })
    await claimTask(task.id)
    await claimTask(task.id)
    expect(task.assigneeUserIds).toEqual([mockGovernor.id])
    await expect(fetchTasksPage('mine', null)).resolves.toMatchObject({ items: [task] })
  })
})
