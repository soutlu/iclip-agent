import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbenchRegistry } from '@/app/workbench-registry'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { WorkbenchRegistryProvider, WorkbenchSelectionProvider } from '@/shared/workbench'
import { addMockCollection, addMockConversation, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { FakeSocket, SERVER_HELLO } from '@/testing/ws'
import { refreshSessionUser } from './session'

// jsdom 不支持装饰动画的 canvas，业务组件与身份请求保持真实。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

const accountA = { ...mockAuthUser, username: 'account-a', displayName: '账号甲' }
const accountB = {
  ...mockAuthUser,
  id: '22222222-2222-4222-8222-222222222222',
  username: 'account-b',
  displayName: '账号乙',
}

/** MSW 持有服务端会话；查询可延迟，验证旧响应不会回填新账号的数据。 */
const serveAccounts = () => {
  let current: typeof accountA | null = accountA
  let failLogout = false
  const pending = new Map<string, Promise<void>>()
  const sidebarReads: string[] = []
  const sidebarRequests: Request[] = []
  const records = new Map(
    [accountA, accountB].map((account) => {
      const collection = addMockCollection(`${account.displayName}的合集`)
      collection.ownerUserId = account.id
      const conversation = addMockConversation(`${account.displayName}的对话`)
      conversation.ownerUserId = account.id
      return [
        account.id,
        {
          collections: [
            { ...collection, conversationCount: 0, page: { items: [], nextCursor: null } },
          ],
          ungroupedCount: 1,
          ungrouped: { items: [conversation], nextCursor: null },
        },
      ]
    }),
  )

  server.use(
    http.get('*/api/users/me', () =>
      current
        ? HttpResponse.json({ user: current })
        : HttpResponse.json({ detail: '未登录' }, { status: 401 }),
    ),
    http.post('*/api/auth/login', async ({ request }) => {
      const body = new URLSearchParams(await request.text())
      current = body.get('username') === accountA.username ? accountA : accountB
      return new HttpResponse(null, { status: 204 })
    }),
    http.post('*/api/auth/logout', () => {
      if (failLogout) return HttpResponse.json({ detail: '退出服务暂不可用' }, { status: 503 })
      current = null
      return new HttpResponse(null, { status: 204 })
    }),
    http.get('*/api/conversations', async ({ request }) => {
      const owner = current
      if (!owner) return HttpResponse.json({ detail: '未登录' }, { status: 401 })
      sidebarReads.push(owner.id)
      sidebarRequests.push(request)
      await pending.get(owner.id)
      return HttpResponse.json(records.get(owner.id))
    }),
  )

  return {
    sidebarReads,
    sidebarRequests,
    changeIdentity: () => {
      current = accountB
    },
    rejectLogout: () => {
      failLogout = true
    },
    holdSidebar: (account: typeof accountA) => {
      let release: (() => void) | undefined
      pending.set(
        account.id,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      return () => {
        pending.delete(account.id)
        release?.()
      }
    },
  }
}

/** 使用真实应用路由、登录弹窗、用户菜单和同一 QueryClient，避免替身缓存掩盖账号边界。 */
const renderWorkspace = async () => {
  const socket = new FakeSocket()
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree,
  })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider createSocket={() => socket as unknown as WebSocket}>
        <WorkbenchRegistryProvider registry={workbenchRegistry}>
          <WorkbenchSelectionProvider>
            <RouterProvider router={router} />
          </WorkbenchSelectionProvider>
        </WorkbenchRegistryProvider>
      </TranscriptProvider>
    </QueryClientProvider>,
  )
  act(() => socket.deliver(SERVER_HELLO))
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
  await screen.findByRole('button', { name: '用户菜单' })
  return user
}

const logout = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: '用户菜单' }))
  await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))
}

const loginAsB = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: '登录' }))
  const dialog = await screen.findByRole('dialog', { name: /登录 Cue/ })
  await user.type(within(dialog).getByRole('textbox', { name: '用户名' }), accountB.username)
  await user.type(within(dialog).getByLabelText('密码'), 'test-password')
  await user.click(within(dialog).getByRole('button', { name: '登录' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: /登录 Cue/ })).not.toBeInTheDocument(),
  )
}

afterEach(() => {
  queryClient.clear()
})

describe('已确认身份变化时的业务缓存', () => {
  it('退出甲后登录乙，乙的数据返回前也不显示甲的新鲜缓存', async () => {
    const accounts = serveAccounts()
    const releaseB = accounts.holdSidebar(accountB)
    const user = await renderWorkspace()
    expect(await screen.findByRole('link', { name: '账号甲的对话' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '关联合集：未关联合集' }))
    await user.click(await screen.findByRole('option', { name: '账号甲的合集' }))
    expect(screen.getByRole('button', { name: '关联合集：账号甲的合集' })).toBeVisible()
    await logout(user)
    await loginAsB(user)

    expect(await screen.findByText('正在加载对话…')).toBeVisible()
    expect(screen.queryByRole('link', { name: '账号甲的对话' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '账号甲的合集 (0)' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关联合集：未关联合集' })).toBeVisible()
    releaseB()
    expect(await screen.findByRole('link', { name: '账号乙的对话' })).toBeVisible()
    expect(accounts.sidebarReads).toEqual([accountA.id, accountB.id])
  })

  it('被动复核发现账号已变更时，同样清理甲的列表并读取乙的数据', async () => {
    const accounts = serveAccounts()
    const releaseB = accounts.holdSidebar(accountB)
    await renderWorkspace()
    await screen.findByRole('link', { name: '账号甲的对话' })
    accounts.changeIdentity()

    await act(async () => {
      await refreshSessionUser()
    })

    expect(await screen.findByText('正在加载对话…')).toBeVisible()
    expect(screen.queryByRole('link', { name: '账号甲的对话' })).not.toBeInTheDocument()
    releaseB()
    expect(await screen.findByRole('link', { name: '账号乙的对话' })).toBeVisible()
  })

  it('退出请求失败时保持原身份和业务内容，不清空列表', async () => {
    const accounts = serveAccounts()
    accounts.rejectLogout()
    const user = await renderWorkspace()
    await screen.findByRole('link', { name: '账号甲的对话' })

    await logout(user)

    await waitFor(() => expect(screen.getByRole('menuitem', { name: '退出登录' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '用户菜单' })).toHaveAttribute('title', '账号甲')
    expect(screen.getByRole('link', { name: '账号甲的对话' })).toBeVisible()
    expect(accounts.sidebarReads).toEqual([accountA.id])
  })

  it('甲的查询仍在途中时切换到乙，迟到的甲响应不能覆盖乙列表', async () => {
    const accounts = serveAccounts()
    const releaseA = accounts.holdSidebar(accountA)
    const user = await renderWorkspace()
    await screen.findByText('正在加载对话…')
    await logout(user)
    await waitFor(() => expect(accounts.sidebarRequests[0]?.signal.aborted).toBe(true))
    await loginAsB(user)
    expect(await screen.findByRole('link', { name: '账号乙的对话' })).toBeVisible()

    await act(async () => {
      releaseA()
    })

    expect(screen.getByRole('link', { name: '账号乙的对话' })).toBeVisible()
    expect(screen.queryByRole('link', { name: '账号甲的对话' })).not.toBeInTheDocument()
  })
})
