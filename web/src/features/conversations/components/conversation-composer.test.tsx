/** 同时挂载真实工作台与会话页，验证选中引用的展示与消息提交。 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { StoryboardPanel } from '@/features/storyboard'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { pasteTextIntoComposer } from '@/testing/editor'
import { server } from '@/testing/mocks/server'
import { seedMockWorkspace, SHOTS_MOCK_PATH } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { ConversationRoute } from './conversation-route'

// jsdom 不支持 Lottie 的 canvas 探测；此处只验证引用与发送行为。
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${SHOTS_MOCK_PATH}`,
  source: { kind: 'file', path: SHOTS_MOCK_PATH, version: 1 },
  title: '分镜',
  type: 'storyboard',
}

const renderChatWithWorkbench = async (initialPath = '/?shot=2') => {
  seedMockWorkspace(CONVERSATION_ID)
  const rendered = await renderWithProviders(
    <>
      <StoryboardPanel artifact={artifact} conversationId={CONVERSATION_ID} readOnly={false} />
      <ConversationRoute conversationId={CONVERSATION_ID} />
    </>,
    { initialPath },
  )
  await screen.findByRole('region', { name: '镜头组 2' })
  return rendered
}

describe('ConversationComposer 上的引用芯片', () => {
  it('工作台选中哪一组，输入框上就出现那一条', async () => {
    await renderChatWithWorkbench()

    expect(await screen.findByText('镜头组 2 · 全局设定 · @Image1')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '第 3 组' }))

    expect(await screen.findByText('镜头组 3 · 全局设定 · @Image1')).toBeVisible()
    expect(screen.queryByText('镜头组 2 · 全局设定 · @Image1')).not.toBeInTheDocument()
  })

  it('选中一帧时引用连帧号一起带上', async () => {
    await renderChatWithWorkbench('/?shot=2&content=scene:2&frame=3')

    expect(await screen.findByText('镜头组 2 · 镜头 2 · @Image3')).toBeVisible()
  })

  it('× 掉的芯片不会自己补回来，换了选中才重新出现', async () => {
    await renderChatWithWorkbench()
    await screen.findByText('镜头组 2 · 全局设定 · @Image1')

    await userEvent.click(
      screen.getByRole('button', { name: '不再引用 镜头组 2 · 全局设定 · @Image1' }),
    )
    await waitFor(() =>
      expect(screen.queryByText('镜头组 2 · 全局设定 · @Image1')).not.toBeInTheDocument(),
    )

    await userEvent.click(screen.getByRole('button', { name: '第 1 组' }))
    await screen.findByText('镜头组 1 · 全局设定 · @Image1')
    await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))

    expect(await screen.findByText('镜头组 2 · 全局设定 · @Image1')).toBeVisible()
  })

  it('带引用发送：提交的正文包含引用前缀，发送成功后芯片收掉', async () => {
    let submittedContent: unknown
    server.use(
      http.post(`*/api/conversations/${CONVERSATION_ID}/prompts`, async ({ request }) => {
        const body = (await request.json()) as { content: unknown; prompt_id: string }
        submittedContent = body.content
        return HttpResponse.json({
          createdAt: '2026-08-31T03:00:00Z',
          promptId: body.prompt_id,
          status: 'running',
        })
      }),
    )
    await renderChatWithWorkbench('/?shot=2&content=scene:2&frame=3')
    await screen.findByText('镜头组 2 · 镜头 2 · @Image3')

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '这一帧的光再暖一点')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() =>
      expect(submittedContent).toEqual([
        { type: 'text', text: '针对镜头组 2 的镜头 2（参考图 @Image3）：\n这一帧的光再暖一点' },
      ]),
    )
    await waitFor(() =>
      expect(screen.queryByText('镜头组 2 · 镜头 2 · @Image3')).not.toBeInTheDocument(),
    )
  })

  it('从只读总览定位镜头组后，输入框同步当前组引用', async () => {
    await renderChatWithWorkbench('/?shot=2&sheet=all')

    const sheet = await screen.findByRole('complementary', { name: '全部镜头组' })
    await userEvent.click(within(sheet).getByRole('button', { name: '查看镜头组 3' }))

    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument())
    expect(await screen.findByText('镜头组 3 · 全局设定 · @Image1')).toBeVisible()
    expect(screen.queryByText('镜头组 2 · 全局设定 · @Image1')).not.toBeInTheDocument()
  })
})
