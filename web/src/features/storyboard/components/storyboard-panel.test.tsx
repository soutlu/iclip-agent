import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { seedMockWorkspace, SHOTS_MOCK_PATH, touchMockShots } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { StoryboardPanel } from './storyboard-panel'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${SHOTS_MOCK_PATH}`,
  source: { kind: 'file', path: SHOTS_MOCK_PATH, version: 1 },
  title: '分镜',
  type: 'storyboard',
}

const renderPanel = (initialPath = '/') =>
  renderWithProviders(<StoryboardPanel artifact={artifact} conversationId={CONVERSATION_ID} />, {
    initialPath,
  })

describe('StoryboardPanel', () => {
  it('铺开镜头组：合计时长、当前组的描述与胶片条', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()

    expect(await screen.findByText('3 组 · 合计 21 秒')).toBeVisible()
    expect(screen.getByRole('heading', { name: /开场，模特提着帆布包/ })).toBeVisible()
    expect(screen.getByText('6 秒 · 1 帧')).toBeVisible()
    // 胶片条三组，序号方块与组名各一份
    expect(screen.getAllByRole('button', { name: /硬切，她从长椅间走向镜头/ })).toHaveLength(1)
  })

  it('翻到下一组把组号写进地址，界面跟着换', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    await screen.findByText('3 组 · 合计 21 秒')
    await userEvent.click(screen.getByRole('button', { name: '下一组' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(screen.getByRole('heading', { name: /硬切，她从长椅间走向镜头/ })).toBeVisible()
    expect(screen.getByText('11 秒 · 2 帧')).toBeVisible()
  })

  it('点缩略图把帧号写进地址', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2')

    await screen.findByText('11 秒 · 2 帧')
    await userEvent.click(screen.getByRole('button', { name: '第 2 帧' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 2, shot: 2 }))
  })

  it('点 prompt 里的帧芯片同样切帧', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2')

    await screen.findByText('11 秒 · 2 帧')
    await userEvent.click(screen.getByRole('button', { name: '高亮第 2 帧' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 2, shot: 2 }))
  })

  it('那一组出过片就放成片，没出过放帧', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { container } = await renderPanel('/?shot=3')

    await screen.findByText('4 秒 · 1 帧')
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())

    await userEvent.click(screen.getByRole('button', { name: '上一组' }))
    await screen.findByText('11 秒 · 2 帧')
    expect(container.querySelector('video')).toBeNull()
  })

  it('文件格式不对时说清楚，不崩', async () => {
    server.use(
      http.get('*/api/conversations/:conversationId/workspace/file', () =>
        HttpResponse.json({
          file: { content: '{ 这不是 JSON', path: SHOTS_MOCK_PATH, version: 1 },
        }),
      ),
    )
    await renderPanel()

    expect(await screen.findByText('文件格式不对，读不出镜头组')).toBeVisible()
  })

  it('收到文件变更就重读，版本变了标出「agent 刚改过」', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { socket } = await renderPanel('/?shot=2')

    await screen.findByText(/走到近处停下微笑/)
    expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument()

    touchMockShots(CONVERSATION_ID)
    socket.deliver({
      payload: {
        changes: [{ change: 'modified', kind: 'file', path: SHOTS_MOCK_PATH }],
        coalesced_window_ms: 0,
      },
      session_id: CONVERSATION_ID,
      type: 'event.fs.changed',
    })

    expect(await screen.findByText(/台词并成一句/)).toBeVisible()
    expect(screen.getAllByText('agent 刚改过')).toHaveLength(3)
  })

  it('点开任一组就把「agent 刚改过」清掉', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { socket } = await renderPanel('/?shot=2')

    await screen.findByText(/走到近处停下微笑/)
    touchMockShots(CONVERSATION_ID)
    socket.deliver({
      payload: {
        changes: [{ change: 'modified', kind: 'file', path: SHOTS_MOCK_PATH }],
        coalesced_window_ms: 0,
      },
      session_id: CONVERSATION_ID,
      type: 'event.fs.changed',
    })

    await screen.findByText(/台词并成一句/)
    await userEvent.click(screen.getByRole('button', { name: '上一组' }))

    await waitFor(() => expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument())
  })
})
