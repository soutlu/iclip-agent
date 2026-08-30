import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import {
  addMockCollection,
  addMockConversation,
  addMockTask,
  mockAuthUser,
  mockCollections,
} from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { AppSidebar } from './-app-sidebar'
import { LoginPromptProvider } from './-login-prompt'

const loginAsUser = () =>
  server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))

/**
 * 把侧栏挂在应用壳的登录信号下渲染。
 *
 * @param requireLogin - 侧栏请求登录时调用的回调。
 * @param initialPath - 起始地址，用来断言侧栏发起的跳转。
 * @returns 渲染结果。
 */
const renderSidebar = (requireLogin = vi.fn(), initialPath = '/') =>
  renderWithProviders(
    <LoginPromptProvider value={requireLogin}>
      <AppSidebar />
    </LoginPromptProvider>,
    { initialPath },
  )

describe('AppSidebar', () => {
  it('jsdom 视为紧凑屏：默认折叠为浮出展开钮，点开展开侧栏', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

    expect(screen.getByRole('complementary')).toBeVisible()
    expect(screen.getByRole('button', { name: '新建任务' })).toBeVisible()
    expect(screen.getByRole('button', { name: '搜索' })).toBeVisible()
    expect(screen.getByRole('button', { name: '需求单' })).toBeVisible()
    expect(screen.getByRole('button', { name: '资料库' })).toBeVisible()
  })

  it('展开后可再折叠回浮出按钮', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeVisible()
  })

  it('未登录时对话区与账户区退成登录入口，点操作即请求登录', async () => {
    const user = userEvent.setup()
    const requireLogin = vi.fn()
    await renderSidebar(requireLogin)

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

    expect(screen.getByText('登录后查看对话')).toBeVisible()
    expect(screen.queryByRole('button', { name: '用户菜单' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(requireLogin).toHaveBeenCalledTimes(2)
  })

  it('已登录时点搜索打开搜对话弹窗', async () => {
    server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))
    const user = userEvent.setup()
    await renderSidebar()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    await user.click(screen.getByRole('button', { name: '搜索' }))

    expect(await screen.findByRole('dialog', { name: '搜索对话' })).toBeVisible()
  })

  it('已登录时点新建任务回首页', async () => {
    server.use(http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })))
    const user = userEvent.setup()
    const { router } = await renderSidebar(vi.fn(), '/tasks')

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    // 等 /users/me 落地：拿到用户前新建任务还挂在登录弹窗上，点了不会跳
    await screen.findByRole('button', { name: '用户菜单' })
    await user.click(screen.getByRole('button', { name: '新建任务' }))

    expect(router.state.location.pathname).toBe('/')
  })
})

describe('AppSidebar 对话区', () => {
  /** 展开侧栏并等登录态落地，返回操作用的 user。 */
  const openSidebar = async () => {
    loginAsUser()
    const user = userEvent.setup()
    await renderSidebar()
    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await screen.findByRole('button', { name: '用户菜单' })
    return user
  }

  it('拓扑分成「任务」与「合集」两区，合集展开后露出里面的对话', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    addMockConversation('没归类的那段')
    addMockConversation('合集里的那段').collectionId = collection.id
    const user = await openSidebar()

    // 标题带条数：任务区是没归类的那些，合集区是合集本身的个数
    expect(await screen.findByRole('button', { name: '任务 (1)' })).toBeVisible()
    expect(screen.getByRole('button', { name: '合集 (1)' })).toBeVisible()
    expect(screen.getByText('没归类的那段')).toBeVisible()
    // 合集默认收起，里面的对话要点开才看得到
    expect(screen.queryByText('合集里的那段')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '夏季亚麻系列 (1)' }))

    expect(screen.getByText('合集里的那段')).toBeVisible()
  })

  it('新建合集后出现在合集区', async () => {
    const user = await openSidebar()
    await screen.findByRole('button', { name: '合集 (0)' })

    await user.click(screen.getByRole('button', { name: '新建合集' }))
    await user.type(await screen.findByLabelText('合集名称'), '春季童鞋')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('button', { name: '春季童鞋 (0)' })).toBeVisible()
  })

  it('合集行菜单可以改名，也可以删掉——删掉不带走里面的对话', async () => {
    const collection = addMockCollection('待改名')
    addMockConversation('里面的对话').collectionId = collection.id
    const user = await openSidebar()
    await screen.findByRole('button', { name: '待改名 (1)' })

    await user.click(screen.getByRole('button', { name: '待改名 的操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByLabelText('合集名称')
    await user.clear(input)
    await user.type(input, '改好了')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('button', { name: '改好了 (1)' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '改好了 的操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '删除合集' })).getByRole('button', {
        name: '删除',
      }),
    )

    await waitFor(() => expect(mockCollections).toHaveLength(0))
    // 对话还在，只是回到了「任务」区
    expect(await screen.findByRole('button', { name: '任务 (1)' })).toBeVisible()
    expect(screen.getByText('里面的对话')).toBeVisible()
  })

  it('归属弹窗把对话放进合集，它就从任务区挪到合集里', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    const conversation = addMockConversation('待归类')
    const user = await openSidebar()
    await screen.findByText('待归类')

    await user.click(screen.getByRole('button', { name: '待归类 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '归属' }))
    const dialog = await screen.findByRole('dialog', { name: '对话归属' })
    await user.selectOptions(within(dialog).getByLabelText('合集'), collection.id)
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(conversation.collectionId).toBe(collection.id))
    expect(await screen.findByRole('button', { name: '任务 (0)' })).toBeVisible()
  })

  it('归属弹窗也能把跑完的对话记到需求单下', async () => {
    const task = addMockTask('儿童运动凉鞋多场景卖点')
    const conversation = addMockConversation('跑完才想起要挂单')
    const user = await openSidebar()
    await screen.findByText('跑完才想起要挂单')

    await user.click(screen.getByRole('button', { name: '跑完才想起要挂单 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '归属' }))
    const dialog = await screen.findByRole('dialog', { name: '对话归属' })
    await user.selectOptions(await within(dialog).findByLabelText('需求单'), task.id)
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(conversation.taskId).toBe(task.id))
    // 只动了需求单那一处，合集那一处没碰
    expect(conversation.collectionId).toBeNull()
  })
})
