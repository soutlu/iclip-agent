import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { LoginForm } from './login-form'

describe('LoginForm', () => {
  it('SSO 关闭时直接展示账号密码区', async () => {
    await renderWithProviders(<LoginForm ssoEnabled={false} onSuccess={vi.fn()} />)

    expect(screen.getByLabelText('用户名')).toBeVisible()
    expect(screen.queryByRole('button', { name: '使用飞书登录' })).not.toBeInTheDocument()
  })

  it('SSO 开启时收起账号密码区，点开后才可见', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<LoginForm ssoEnabled onSuccess={vi.fn()} />)

    expect(screen.getByRole('button', { name: '使用飞书登录' })).toBeVisible()
    expect(screen.getByLabelText('用户名')).not.toBeVisible()

    await user.click(screen.getByRole('button', { name: '使用账号密码登录' }))

    expect(screen.getByLabelText('用户名')).toBeVisible()
  })

  it('提交用户名密码后以表单登录并回调 onSuccess', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()
    // 仅记录请求，保留原 handler 的登录状态更新。
    const loginBodies: Promise<string>[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/api/auth/login')) {
        loginBodies.push(request.clone().text())
      }
    })
    await renderWithProviders(<LoginForm ssoEnabled={false} onSuccess={onSuccess} />)

    await user.type(screen.getByLabelText('用户名'), 'tester')
    await user.type(screen.getByLabelText('密码'), 'secret')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1)
    })
    const form = new URLSearchParams(await loginBodies[0])
    expect(form.get('username')).toBe('tester')
    expect(form.get('password')).toBe('secret')
  })

  it('登录失败时把后端错误文案展示在表单顶部，不回调 onSuccess', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()
    server.use(
      http.post('*/api/auth/login', () =>
        HttpResponse.json({ detail: '用户名或密码错误' }, { status: 401 }),
      ),
    )
    await renderWithProviders(<LoginForm ssoEnabled={false} onSuccess={onSuccess} />)

    await user.type(screen.getByLabelText('用户名'), 'tester')
    await user.type(screen.getByLabelText('密码'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误')
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
