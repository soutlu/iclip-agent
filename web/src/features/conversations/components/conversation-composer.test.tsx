/**
 * 输入框上的引用芯片：谁选中的、怎么撤掉、发出去的正文长什么样。
 *
 * 选中态由工作台报进 `shared/workbench`，所以这里把真的工作台一起挂上——两个 feature 在应用里就是
 * 这样经同一份上下文见面的（`app/app.tsx`），不另造一个报选中的假组件。
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StoryboardPanel } from '@/features/storyboard'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { pasteTextIntoComposer } from '@/testing/editor'
import { seedMockWorkspace, SHOTS_MOCK_PATH } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { ConversationComposer } from './conversation-composer'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${SHOTS_MOCK_PATH}`,
  source: { kind: 'file', path: SHOTS_MOCK_PATH, version: 1 },
  title: '分镜',
  type: 'storyboard',
}

const renderChatWithWorkbench = async (initialPath = '/?shot=2') => {
  seedMockWorkspace(CONVERSATION_ID)
  const onSend = vi.fn(() => Promise.resolve())
  const rendered = await renderWithProviders(
    <>
      <StoryboardPanel artifact={artifact} conversationId={CONVERSATION_ID} />
      <ConversationComposer
        contextTokens={undefined}
        maxContextTokens={undefined}
        onSend={onSend}
      />
    </>,
    { initialPath },
  )
  await screen.findByText('3 组 · 合计 21 秒 · 第 2 组')
  return { ...rendered, onSend }
}

describe('ConversationComposer 上的引用芯片', () => {
  it('工作台选中哪一组，输入框上就出现那一条', async () => {
    await renderChatWithWorkbench()

    expect(await screen.findByText('镜头组 2')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '第 3 组' }))

    expect(await screen.findByText('镜头组 3')).toBeVisible()
    expect(screen.queryByText('镜头组 2')).not.toBeInTheDocument()
  })

  it('选中一帧时引用连帧号一起带上', async () => {
    await renderChatWithWorkbench('/?shot=2&frame=3')

    expect(await screen.findByText('镜头组 2 · 帧 @3')).toBeVisible()
  })

  it('× 掉的芯片不会自己补回来，换了选中才重新出现', async () => {
    await renderChatWithWorkbench()
    await screen.findByText('镜头组 2')

    await userEvent.click(screen.getByRole('button', { name: '不再引用 镜头组 2' }))
    await waitFor(() => expect(screen.queryByText('镜头组 2')).not.toBeInTheDocument())

    // 同一组来回翻一趟：选中变过了，引用才回来
    await userEvent.click(screen.getByRole('button', { name: '第 1 组' }))
    await screen.findByText('镜头组 1')
    await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))

    expect(await screen.findByText('镜头组 2')).toBeVisible()
  })

  it('带引用发送：每条引用一行前缀拼在正文前面，发完芯片收掉', async () => {
    const { onSend } = await renderChatWithWorkbench('/?shot=2&frame=3')
    await screen.findByText('镜头组 2 · 帧 @3')

    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '这一帧的光再暖一点')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        '针对镜头组 2 的帧 @3：\n这一帧的光再暖一点',
        [],
        [{ kind: 'text', text: '针对镜头组 2 的帧 @3：\n这一帧的光再暖一点' }],
      ),
    )
    await waitFor(() => expect(screen.queryByText('镜头组 2 · 帧 @3')).not.toBeInTheDocument())
  })

  it('「全部分镜」里的「在聊天里说」把选中的几组一起变成引用', async () => {
    await renderChatWithWorkbench()

    await userEvent.click(screen.getByRole('button', { name: '全部分镜' }))
    const sheet = await screen.findByRole('complementary', { name: '全部分镜' })
    await userEvent.click(within(sheet).getByRole('button', { name: '全选' }))
    await userEvent.click(within(sheet).getByRole('button', { name: '在聊天里说' }))

    // 浮层关掉，三条引用都在输入框上
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument())
    for (const label of ['镜头组 1', '镜头组 2', '镜头组 3']) {
      expect(screen.getByText(label)).toBeVisible()
    }
  })
})
