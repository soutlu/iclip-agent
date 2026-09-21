import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { addMockTask, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { claimTask, listAllTasks, listMyTasks } from './tasks.api'

describe('listAllTasks', () => {
  it('按接口上限读取全平台需求单，不带认领人过滤', async () => {
    const task = addMockTask('夏季系列短片')
    let requestUrl: URL | undefined
    server.use(
      http.get('*/api/tasks', ({ request }) => {
        requestUrl = new URL(request.url)
        return HttpResponse.json({ items: [task] })
      }),
    )

    await expect(listAllTasks()).resolves.toEqual([task])
    expect(requestUrl?.searchParams.toString()).toBe('limit=100')
  })

  it('读取失败时抛出服务错误，供候选列表展示和重试', async () => {
    server.use(
      http.get('*/api/tasks', () =>
        HttpResponse.json({ detail: '需求单服务暂不可用' }, { status: 503 }),
      ),
    )

    await expect(listAllTasks()).rejects.toThrow('读取需求单列表失败：需求单服务暂不可用')
  })

  it('取消候选查询时中断正在读取的请求', async () => {
    let pendingRequest: Request | undefined
    server.use(
      http.get('*/api/tasks', async ({ request }) => {
        pendingRequest = request
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return HttpResponse.json({ items: [] })
      }),
    )

    const controller = new AbortController()
    const response = listAllTasks(controller.signal)
    const rejection = expect(response).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(pendingRequest).toBeDefined())
    controller.abort()

    await rejection
    expect(pendingRequest?.signal.aborted).toBe(true)
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
    await expect(listMyTasks()).resolves.toEqual([task])
  })
})
