import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { CueUserMenu } from './cue-user-menu'

/** 已登录用户的头像菜单；后面跟一个页面控件，用来确认焦点不会跑出菜单。 */
async function renderMenu() {
  loginAs(mockAuthUser)
  await renderWithProviders(
    <>
      <CueUserMenu />
      <button type="button">页面后续控件</button>
    </>,
  )
  const trigger = screen.getByRole('button', { name: '用户菜单' })
  await waitFor(() => expect(trigger).toHaveAttribute('title', mockAuthUser.displayName))
  return trigger
}

describe('CueUserMenu', () => {
  it('点开后方向键进到菜单项，Tab 不会跳到页面后续控件', async () => {
    const user = userEvent.setup()
    const trigger = await renderMenu()

    await user.click(trigger)
    const logout = await screen.findByRole('menuitem', { name: '退出登录' })
    await user.keyboard('{ArrowDown}')
    expect(logout).toHaveFocus()
    await user.tab()

    expect(logout).toHaveFocus()
    expect(screen.getByRole('button', { name: '页面后续控件', hidden: true })).not.toHaveFocus()
  })

  it('键盘打开时焦点落在菜单项上，Escape 关上并回到头像', async () => {
    const user = userEvent.setup()
    const trigger = await renderMenu()

    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: '退出登录' })).toHaveFocus()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('点退出登录发出退出请求，会话清空后头像回到通用轮廓', async () => {
    const user = userEvent.setup()
    const logouts: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/api/auth/logout')) {
        logouts.push(request.url)
      }
    })
    const trigger = await renderMenu()

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))

    await waitFor(() => expect(logouts).toHaveLength(1))
    await waitFor(() => expect(trigger).toHaveAttribute('title', '用户'))
  })
})
