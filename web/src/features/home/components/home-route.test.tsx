import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
import { HomeRoute } from './home-route'

// jsdom 缺少 Lottie 所需 canvas，替换装饰动画以验证标题与输入卡。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

describe('HomeRoute', () => {
  it('渲染标题与输入卡；游客没有附件上传入口', async () => {
    await renderWithProviders(<HomeRoute />)

    expect(screen.getByRole('heading', { name: 'Cue' })).toBeVisible()
    expect(screen.getByLabelText('输入消息')).toBeVisible()
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument()
    expect(screen.getByText('未关联合集')).toBeVisible()
  })

  it('空输入时发送钮禁用，输入后放开', async () => {
    await renderWithProviders(<HomeRoute />)

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '做一个产品宣传片')

    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  })

  it('发送把话与选中的 agent 一起交出去，并清空输入框', async () => {
    const user = userEvent.setup()
    const sent: { agentId: string }[] = []
    await renderWithProviders(<HomeRoute onSend={(input) => sent.push(input)} />)

    await user.click(screen.getByRole('button', { name: /分镜 Agent/ }))
    await user.click(await screen.findByRole('menuitem', { name: '通用助手' }))
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '做一个产品宣传片')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(sent).toEqual([
      { agentId: 'assistant', parts: [{ kind: 'text', text: '做一个产品宣传片' }] },
    ])
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('')
  })
})
