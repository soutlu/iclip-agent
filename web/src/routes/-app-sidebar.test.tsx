import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { AppSidebar } from './-app-sidebar'
import { LoginPromptProvider } from './-login-prompt'

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
    expect(screen.getByRole('tab', { name: '进行中' })).toBeVisible()
    expect(screen.getByRole('tab', { name: '已完成' })).toBeVisible()
    expect(screen.getByRole('tab', { name: '工作空间' })).toBeVisible()
  })

  it('展开后可再折叠回浮出按钮', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeVisible()
  })

  it('未登录时会话区与账户区退成登录入口，点操作即请求登录', async () => {
    const user = userEvent.setup()
    const requireLogin = vi.fn()
    await renderSidebar(requireLogin)

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

    expect(screen.getByText('登录后查看会话')).toBeVisible()
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
