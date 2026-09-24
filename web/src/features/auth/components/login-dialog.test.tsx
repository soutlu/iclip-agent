import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { LoginDialog } from './login-dialog'

const SSO_UNAVAILABLE = '飞书登录暂不可用，请使用账号密码登录'
const serveSsoProbe = (respond: () => Response) =>
  server.use(http.get('*/api/auth/sso/authorize', respond))
const ssoOpen = () => HttpResponse.json({ authorization_url: 'https://sso.example.com/authorize' })

describe('LoginDialog', () => {
  it('SSO 开启时显示飞书入口，不出现故障提示', async () => {
    serveSsoProbe(ssoOpen)
    await renderWithProviders(<LoginDialog open onOpenChange={vi.fn()} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })

    expect(await within(dialog).findByRole('button', { name: '使用飞书登录' })).toBeVisible()
    expect(within(dialog).queryByText(SSO_UNAVAILABLE)).not.toBeInTheDocument()
  })

  it('SSO 探测 500 时提示飞书登录暂不可用，账号密码仍可登录', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    serveSsoProbe(() => new HttpResponse(null, { status: 500 }))
    await renderWithProviders(<LoginDialog open onOpenChange={onOpenChange} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(SSO_UNAVAILABLE)
    expect(within(dialog).queryByRole('button', { name: '使用飞书登录' })).not.toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('用户名'), 'tester')
    await user.type(within(dialog).getByLabelText('密码'), 'secret')
    await user.click(within(dialog).getByRole('button', { name: '登录' }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('探测失败后点重试，恢复即出现飞书入口', async () => {
    const user = userEvent.setup()
    serveSsoProbe(() => new HttpResponse(null, { status: 503 }))
    await renderWithProviders(<LoginDialog open onOpenChange={vi.fn()} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })
    await within(dialog).findByText(SSO_UNAVAILABLE)

    serveSsoProbe(ssoOpen)
    await user.click(within(dialog).getByRole('button', { name: '重试' }))

    expect(await within(dialog).findByRole('button', { name: '使用飞书登录' })).toBeVisible()
    expect(within(dialog).queryByText(SSO_UNAVAILABLE)).not.toBeInTheDocument()
  })
})
