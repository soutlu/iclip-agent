import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerSubmission } from '@/shared/ui/composer'
import { Toaster, toast } from '@/shared/ui/toast'
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

beforeEach(() => {
  window.sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
  toast.dismiss()
})

describe('HomeRoute', () => {
  it('渲染标题、输入卡及路由传入的选择控件，默认没有附件入口', async () => {
    await renderWithProviders(
      <HomeRoute
        agentPicker={<button type="button">选择 Agent</button>}
        collectionPicker={<button type="button">关联合集</button>}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Cue' })).toBeVisible()
    expect(screen.getByLabelText('输入消息')).toBeVisible()
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择 Agent' })).toBeVisible()
    expect(screen.getByRole('button', { name: '关联合集' })).toBeVisible()
  })

  it('附件入口由外部权限判断开启', async () => {
    await renderWithProviders(<HomeRoute attachmentsEnabled />)
    expect(screen.getByRole('button', { name: '添加附件' })).toBeVisible()
  })

  it.each([true, false])('发送返回 %s 时只在成功后清空正文', async (success) => {
    const user = userEvent.setup()
    const sent: ComposerSubmission[] = []
    await renderWithProviders(
      <HomeRoute
        onSend={async (input) => {
          sent.push(input)
          return success
        }}
      />,
    )
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '做一个产品宣传片')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(sent).toEqual([
      {
        media: [],
        parts: [{ kind: 'text', text: '做一个产品宣传片' }],
        text: '做一个产品宣传片',
      },
    ])
    expect(screen.getByLabelText('输入消息').textContent).toBe(success ? '' : '做一个产品宣传片')
  })

  it('发送仍在等待结果时保留输入，并阻止重复发送', async () => {
    const user = userEvent.setup()
    const sent: ComposerSubmission[] = []
    let resolveSend: (value: boolean) => void = () => {}
    const pending = new Promise<boolean>((resolve) => {
      resolveSend = resolve
    })
    await renderWithProviders(
      <HomeRoute
        onSend={(input) => {
          sent.push(input)
          return pending
        }}
      />,
    )
    const editor = screen.getByLabelText('输入消息')
    pasteTextIntoComposer(editor, '正在发送的创作要求')
    await user.dblClick(screen.getByRole('button', { name: '发送' }))
    expect(sent).toHaveLength(1)
    expect(editor).toHaveTextContent('正在发送的创作要求')
    await act(async () => {
      resolveSend(true)
      await pending
    })
    await waitFor(() => expect(editor.textContent).toBe(''))
  })

  it('外部发送状态禁用发送按钮并保留当前输入', async () => {
    await renderWithProviders(<HomeRoute sending />)
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '正在发送的创作要求')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('正在发送的创作要求')
  })

  it('游客发送仅暂存正文，整页登录返回后恢复一次并移除暂存', async () => {
    const user = userEvent.setup()
    const guest = await renderWithProviders(
      <HomeRoute preserveForLogin onSend={async () => false} />,
    )
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '登录后继续制作产品宣传片')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('登录后继续制作产品宣传片')
    guest.unmount()

    const returned = await renderWithProviders(<HomeRoute />)
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('登录后继续制作产品宣传片')
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    returned.unmount()

    await renderWithProviders(<HomeRoute />)
    expect(screen.getByLabelText('输入消息').textContent).toBe('')
  })

  it('暂存失败时提示复制正文，保留当前输入并停止登录跳转', async () => {
    const user = userEvent.setup()
    const sent: ComposerSubmission[] = []
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('storage unavailable', 'QuotaExceededError')
      },
    })
    await renderWithProviders(
      <>
        <Toaster />
        <HomeRoute
          preserveForLogin
          onSend={async (input) => {
            sent.push(input)
            return false
          }}
        />
      </>,
    )
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '请保留这一段创作要求')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('浏览器无法暂存输入，请复制内容后再登录')).toBeVisible()
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('请保留这一段创作要求')
    expect(sent).toHaveLength(0)
  })
})
