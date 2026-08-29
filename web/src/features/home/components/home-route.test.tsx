import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { HomeRoute } from './home-route'

// lottie-web 在模块加载时就探测 canvas 2d context，jsdom 里拿不到会直接抛。
// hero 动画是 aria-hidden 的装饰件，这些用例断言的是标题与输入卡。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: { loadAnimation: () => ({ destroy: () => undefined }) },
}))

describe('HomeRoute', () => {
  it('渲染标题与输入卡', async () => {
    await renderWithProviders(<HomeRoute />)

    expect(screen.getByRole('heading', { name: 'Producer' })).toBeVisible()
    expect(screen.getByLabelText('输入消息')).toBeVisible()
    expect(screen.getByRole('button', { name: '添加' })).toBeVisible()
    expect(screen.getByText('未关联项目')).toBeVisible()
  })

  it('空输入时发送钮禁用，输入后放开', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<HomeRoute />)

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()

    await user.type(screen.getByLabelText('输入消息'), '做一个产品宣传片')

    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  })
})
