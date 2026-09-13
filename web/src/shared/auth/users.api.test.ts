import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { fetchUsersDirectory } from './users.api'

const directoryUsers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ...mockAuthUser,
    displayName: `用户 ${index + 1}`,
    id: crypto.randomUUID(),
  }))

describe('fetchUsersDirectory', () => {
  it.each([
    { count: 0, pages: [1] },
    { count: 200, pages: [1] },
    { count: 405, pages: [1, 2, 3] },
  ])('读取 $count 人名册，只请求 total 所需页数', async ({ count, pages }) => {
    const accounts = directoryUsers(count)
    const requests: { page: number; pageSize: number }[] = []
    server.use(
      http.get('*/api/users', ({ request }) => {
        const params = new URL(request.url).searchParams
        const page = Number(params.get('page'))
        const pageSize = Number(params.get('pageSize'))
        requests.push({ page, pageSize })
        return HttpResponse.json({
          items: accounts.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: count,
        })
      }),
    )

    const users = await fetchUsersDirectory()

    expect(requests).toEqual(pages.map((page) => ({ page, pageSize: 200 })))
    expect(users).toHaveLength(count)
    if (count > 0) {
      expect(users.find((user) => user.id === accounts.at(-1)?.id)?.displayName).toBe(
        `用户 ${count}`,
      )
    }
  })

  it('后续页请求失败时抛出服务错误，不返回不完整名册', async () => {
    const accounts = directoryUsers(200)
    server.use(
      http.get('*/api/users', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page'))
        if (page === 2) {
          return HttpResponse.json({ detail: '用户服务暂不可用' }, { status: 503 })
        }
        return HttpResponse.json({ items: accounts, page, pageSize: 200, total: 201 })
      }),
    )

    await expect(fetchUsersDirectory()).rejects.toThrow('读取用户名册失败：用户服务暂不可用')
  })

  it('取消查询时中断正在读取的后续页，并停止翻页', async () => {
    const accounts = directoryUsers(200)
    const requestedPages: number[] = []
    let pendingRequest: Request | undefined
    server.use(
      http.get('*/api/users', async ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page'))
        requestedPages.push(page)
        if (page === 2) {
          pendingRequest = request
          await new Promise<void>((resolve) => {
            request.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        return HttpResponse.json({ items: accounts, page, pageSize: 200, total: 401 })
      }),
    )

    const controller = new AbortController()
    const response = fetchUsersDirectory(controller.signal)
    const rejection = expect(response).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(pendingRequest).toBeDefined())
    controller.abort()

    await rejection
    expect(pendingRequest?.signal.aborted).toBe(true)
    expect(requestedPages).toEqual([1, 2])
  })
})
