import { act, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addMockConversation, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SERVER_HELLO } from '@/testing/ws'
import { DEFAULT_AUDIT_FILTERS, useAuditConversations } from './audit.api'
import { conversationsQueryKeys, type Conversation } from './conversations.api'
import { useLiveConversations } from './conversations.live'

/** 全局帧订阅在应用里挂在侧栏顶层；这里单独挂一次，只看它对各份会话缓存做了什么。 */
function LiveFrames() {
  useLiveConversations()
  return null
}

/** 全部对话页的那份无限查询；有它挂着，失效才会真的发请求。 */
function AuditList() {
  useAuditConversations(DEFAULT_AUDIT_FILTERS, true)
  return null
}

/** 登录身份缓存键，等它落定后再发帧，属主判断才是确定的。 */
const AUTH_USER_KEY = ['auth', 'current-user']

const AUDIT_KEY = conversationsQueryKeys.audit(DEFAULT_AUDIT_FILTERS)
const SIDEBAR_KEY = conversationsQueryKeys.sidebar('all')
const MORE_KEY = conversationsQueryKeys.more('ungrouped', 'cursor-1', 'all')

/** 去抖窗口一到就重拉；断言前统一推过这个窗口，不关心失效是立刻还是攒一下。 */
const AUDIT_WINDOW_MS = 1500

const conversationRow = (overrides: Partial<Conversation> = {}): Conversation => {
  const row = addMockConversation('小王的秋季片', '2026-09-20T00:00:00Z')
  return { ...row, completedAt: '2026-09-20T01:00:00Z', ...overrides }
}

const seedCaches = (queryClient: QueryClient, row: Conversation) => {
  queryClient.setQueryData(AUDIT_KEY, {
    pageParams: [null],
    pages: [{ items: [row], nextCursor: null, runningTotal: 0, total: 1 }],
  })
  queryClient.setQueryData(SIDEBAR_KEY, {
    collections: [],
    ungrouped: { items: [row], nextCursor: null },
    ungroupedCount: 1,
  })
  queryClient.setQueryData(MORE_KEY, [row])
}

/** 三份缓存形状不同：无限查询按页装、拓扑装在 ungrouped 里、额外分页就是个数组。 */
type SeededCache =
  { pages?: { items: Conversation[] }[]; ungrouped?: { items: Conversation[] } } | Conversation[]

const rowIn = (queryClient: QueryClient, key: readonly unknown[]): Conversation | undefined => {
  const data = queryClient.getQueryData<SeededCache>(key)
  if (Array.isArray(data)) return data[0]
  return data?.pages?.[0]?.items[0] ?? data?.ungrouped?.items[0]
}

const invalidated = (queryClient: QueryClient, key: readonly unknown[]): boolean =>
  queryClient.getQueryState(key)?.isInvalidated ?? false

const activityFrame = (
  conversationId: string,
  payload: {
    busy: boolean
    pending_interaction?: 'none' | 'approval' | 'question'
    last_turn_reason?: 'completed' | 'failed' | 'aborted'
  },
) => ({
  payload: { pending_interaction: 'none', ...payload },
  session_id: conversationId,
  type: 'event.session.work_changed',
})

const titleFrame = (conversationId: string, title: string) => ({
  payload: { session_id: conversationId, title },
  type: 'session.meta.updated',
})

const generationFrame = (conversationId: string, kind: 'video' | 'image') => ({
  payload: { id: 'job-1', kind, status: 'running' },
  session_id: conversationId,
  type: 'event.generation.changed',
})

/** 挂上订阅并等登录身份落定；随后接管 setTimeout，方便推过去抖窗口。 */
const mount = async () => {
  server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))
  const rendered = await renderWithProviders(<LiveFrames />)
  await waitFor(() => expect(rendered.queryClient.getQueryData(AUTH_USER_KEY)).toBeTruthy())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return rendered
}

const settle = (ms = AUDIT_WINDOW_MS) => act(() => vi.advanceTimersByTime(ms))

afterEach(() => {
  vi.useRealTimers()
})

describe('useLiveConversations', () => {
  it('活动帧就地改各份缓存里的行并抹掉收尾标记，同时重拉全部对话页', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(activityFrame(row.id, { busy: true }))
    await settle()

    for (const key of [AUDIT_KEY, SIDEBAR_KEY, MORE_KEY]) {
      expect(rowIn(queryClient, key)).toMatchObject({
        activity: { busy: true, pendingInteraction: 'none' },
        completedAt: null,
      })
    }
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
  })

  it('改名帧只换标题，不动分页也不重拉任何列表', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(titleFrame(row.id, '改过的名字'))
    await settle()

    expect(rowIn(queryClient, AUDIT_KEY)).toMatchObject({
      completedAt: row.completedAt,
      title: '改过的名字',
    })
    expect(rowIn(queryClient, SIDEBAR_KEY)?.title).toBe('改过的名字')
    expect(queryClient.getQueryData(MORE_KEY)).toBeDefined()
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
  })

  it('自己对话的出片帧抹掉收尾标记，丢掉额外分页并重拉拓扑与全部对话页', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(generationFrame(row.id, 'video'))
    await settle()

    expect(rowIn(queryClient, AUDIT_KEY)?.completedAt).toBeNull()
    expect(queryClient.getQueryData(MORE_KEY)).toBeUndefined()
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(true)
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
  })

  it('图片帧只抹收尾标记，行上的视频汇总没变就不重拉', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(generationFrame(row.id, 'image'))
    await settle()

    expect(rowIn(queryClient, AUDIT_KEY)?.completedAt).toBeNull()
    expect(queryClient.getQueryData(MORE_KEY)).toBeDefined()
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
  })

  it('重连后丢掉额外分页并重拉拓扑与全部对话页', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.onclose?.()
    // 退避重连排在定时器上，推过去才会重新握手。
    await settle(2000)
    socket.deliver(SERVER_HELLO)
    await settle()

    expect(queryClient.getQueryData(MORE_KEY)).toBeUndefined()
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(true)
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
  })

  it('只有待办变化的帧就地补丁就够，不重拉全部对话页', async () => {
    const row = conversationRow({
      activity: {
        busy: true,
        lastTurnReason: null,
        pendingInteraction: 'none',
        videoGeneration: 'none',
      },
    })
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(activityFrame(row.id, { busy: true, pending_interaction: 'approval' }))
    await settle()

    expect(rowIn(queryClient, AUDIT_KEY)?.activity.pendingInteraction).toBe('approval')
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
  })

  it.each([
    [
      '忙闲相对缓存翻转',
      { busy: true } as const,
      { busy: false, lastTurnReason: null, pendingInteraction: 'none' } as const,
    ],
    [
      '这一帧是收尾',
      { busy: false, last_turn_reason: 'completed' } as const,
      { busy: false, lastTurnReason: 'failed', pendingInteraction: 'none' } as const,
    ],
  ])('%s 时重拉全部对话页', async (_label, frame, cachedActivity) => {
    const row = conversationRow({ activity: { ...cachedActivity, videoGeneration: 'none' } })
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(activityFrame(row.id, frame))
    await settle()

    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
  })

  it('缓存里没有这段对话时重拉，让新对话出现在全部对话页', async () => {
    const cached = conversationRow()
    const fresh = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, cached)
    // 侧栏里有、全部对话页里没有的对话，同样要靠重拉才出现。
    queryClient.setQueryData(SIDEBAR_KEY, {
      collections: [],
      ungrouped: { items: [cached, fresh], nextCursor: null },
      ungroupedCount: 2,
    })

    socket.deliver(activityFrame(fresh.id, { busy: false, last_turn_reason: 'aborted' }))
    await settle()

    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
  })

  it('一阵帧只重拉一次全部对话页', async () => {
    const reads: string[] = []
    server.use(
      http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })),
      http.get('*/api/conversations/audit', ({ request }) => {
        reads.push(new URL(request.url).search)
        return HttpResponse.json({ items: [], nextCursor: null, runningTotal: 0, total: 0 })
      }),
    )
    const { queryClient, socket } = await renderWithProviders(
      <>
        <LiveFrames />
        <AuditList />
      </>,
    )
    await waitFor(() => expect(queryClient.getQueryData(AUTH_USER_KEY)).toBeTruthy())
    await waitFor(() => expect(reads).toHaveLength(1))

    // 缓存里一段都没有，每一帧单看都够格重拉。
    for (let index = 0; index < 5; index += 1) {
      socket.deliver(activityFrame(conversationRow().id, { busy: true }))
    }

    await waitFor(() => expect(reads).toHaveLength(2), { timeout: 3000 })
    await new Promise((resolve) => setTimeout(resolve, AUDIT_WINDOW_MS))
    expect(reads).toHaveLength(2)
    // 这条要等真实的去抖窗口，慢机上留足余量。
  }, 10_000)
})
