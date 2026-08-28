import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { AppSidebar } from './-app-sidebar'

describe('AppSidebar', () => {
  it('jsdom 视为紧凑屏：默认折叠为浮出展开钮，点开展开侧栏', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<AppSidebar />)

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))

    expect(screen.getByRole('complementary')).toBeVisible()
    expect(screen.getByRole('button', { name: '新建对话' })).toBeVisible()
    expect(screen.getByRole('button', { name: '搜索' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '会话' })).toBeVisible()
    expect(screen.getByText('还没有会话 · 点击 新建对话 开始')).toBeVisible()
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeVisible()
  })

  it('展开后可再折叠回浮出按钮', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<AppSidebar />)

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    await user.click(screen.getByRole('button', { name: '折叠侧边栏' }))

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeVisible()
  })
})
