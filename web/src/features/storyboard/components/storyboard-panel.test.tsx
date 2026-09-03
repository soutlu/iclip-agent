/**
 * 工作台整体：读文件、翻组、切帧、抽屉、agent 改过标记。
 *
 * 翻组的真实手势是滚轮，而 jsdom 里容器没有高度、也不真滚，所以这里走「三条路都只改地址里的
 * shot」这条设计：用页码点与键盘断言翻组，滚轮那一条在 e2e 里验。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { server } from '@/testing/mocks/server'
import { seedMockWorkspace, SHOTS_MOCK_PATH, touchMockShots } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
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

const fsChanged = {
  payload: {
    changes: [{ change: 'modified', kind: 'file', path: SHOTS_MOCK_PATH }],
    coalesced_window_ms: 0,
  },
  session_id: CONVERSATION_ID,
  type: 'event.fs.changed',
}

describe('StoryboardPanel', () => {
  it('页头给组数、合计时长与当前是第几组', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()

    expect(await screen.findByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()
    // 三组各一页，都在滚动容器里
    expect(screen.getAllByRole('region', { name: /镜头组 \d/ })).toHaveLength(3)
  })

  it('点页码点翻到那一组，组号进地址', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    await screen.findByText('3 组 · 合计 21 秒 · 第 1 组')
    await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(screen.getByText('3 组 · 合计 21 秒 · 第 2 组')).toBeVisible()
  })

  it('页码点上按 ↑↓ 也翻组，到头了不再动', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    const firstDot = await screen.findByRole('button', { name: '第 1 组' })
    firstDot.focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(router.state.location.search).toEqual({})

    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
  })

  it('换组把帧号丢掉：上一组的第 3 帧在新组上没有意义', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2&frame=3')

    await screen.findByText('3 组 · 合计 21 秒 · 第 2 组')
    await userEvent.click(screen.getByRole('button', { name: '第 1 组' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 1 }))
  })

  it('点描述里的帧芯片把帧号写进地址', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2')

    const page = await screen.findByRole('region', { name: '镜头组 2' })
    await userEvent.click(within(page).getByRole('button', { name: '看第 2 帧' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 2, shot: 2 }))
  })

  it('「生成记录」开抽屉、写进地址，✕ 关掉', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2')

    await screen.findByText('3 组 · 合计 21 秒 · 第 2 组')
    await userEvent.click(screen.getByRole('button', { name: '生成记录' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ sheet: 'records', shot: 2 }))
    const drawer = screen.getByRole('complementary', { name: '生成记录' })
    // 第 2 组名下三条视频任务：完成、失败、还在飞
    expect(within(drawer).getByRole('radio', { name: '视频生成记录 3' })).toBeVisible()

    await userEvent.click(within(drawer).getByRole('button', { name: '关闭生成记录' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
  })

  it('地址里带 sheet=records 进来就是开着的', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel('/?shot=2&sheet=records')

    expect(await screen.findByRole('complementary', { name: '生成记录' })).toBeVisible()
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

    await screen.findByText(/再低头看一眼包/)
    expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument()

    touchMockShots(CONVERSATION_ID)
    socket.deliver(fsChanged)

    expect(await screen.findByText(/台词并成一句/)).toBeVisible()
    expect(screen.getByText('agent 刚改过')).toBeVisible()
  })

  it('改了时长停手即存：写回带版本号，页头出「已保存」，自己写的版本不算 agent 改过', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    let written: { expectedVersion?: number; content?: string } = {}
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PUT' && request.url.includes('/workspace/file')) {
        void request
          .clone()
          .json()
          .then((body: { expectedVersion: number; content: string }) => {
            written = body
          })
      }
    })
    await renderPanel('/?shot=2')
    await screen.findByText(/再低头看一眼包/)

    const input = within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('spinbutton', {
      name: '镜头组 2 的时长（秒）',
    })
    fireEvent.change(input, { target: { value: '12' } })

    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()
    expect(written.expectedVersion).toBe(1)
    expect(JSON.parse(written.content ?? '{}')).toMatchObject({
      shots: [{ index: 1 }, { index: 2, seconds: 12 }, { index: 3 }],
    })
    expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument()
  })

  it('版本撞车但改的不是同一组：重放我的改动到最新版上再存', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel('/?shot=1')
    await screen.findByText('3 组 · 合计 21 秒 · 第 1 组')

    // agent 悄悄改了第 2 组，版本到 2；我改第 1 组，手上还是版本 1
    touchMockShots(CONVERSATION_ID)
    const input = within(screen.getByRole('region', { name: '镜头组 1' })).getByRole('spinbutton', {
      name: '镜头组 1 的时长（秒）',
    })
    fireEvent.change(input, { target: { value: '8' } })

    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()
    // 第 2 组是 agent 的新版本，第 1 组是我的
    await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))
    expect(await screen.findByText(/台词并成一句/)).toBeVisible()
  })

  it('两边改了同一组：弹出选择，选「用最新的」就丢掉我的', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel('/?shot=2')
    await screen.findByText(/再低头看一眼包/)

    touchMockShots(CONVERSATION_ID)
    const input = within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('spinbutton', {
      name: '镜头组 2 的时长（秒）',
    })
    fireEvent.change(input, { target: { value: '13' } })

    const dialog = await screen.findByRole(
      'dialog',
      { name: '这一组有别的改动' },
      { timeout: 3000 },
    )
    expect(dialog).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: '用最新的' }))

    expect(await screen.findByText(/台词并成一句/)).toBeVisible()
    expect(input).toHaveValue(11)
  })

  it('形状不合规存不下去：原文照实显示', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    server.use(
      http.put('*/api/conversations/:id/workspace/file', () =>
        HttpResponse.json({ detail: '镜头组 2 的 seconds 要是 4-30 的整数' }, { status: 422 }),
      ),
    )
    await renderPanel('/?shot=2')
    await screen.findByText(/再低头看一眼包/)

    const input = within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('spinbutton', {
      name: '镜头组 2 的时长（秒）',
    })
    fireEvent.change(input, { target: { value: '12' } })

    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '没存下',
    )
  })

  it('翻页就把「agent 刚改过」清掉', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { socket } = await renderPanel('/?shot=2')

    await screen.findByText(/再低头看一眼包/)
    touchMockShots(CONVERSATION_ID)
    socket.deliver(fsChanged)
    await screen.findByText(/台词并成一句/)

    await userEvent.click(screen.getByRole('button', { name: '第 3 组' }))

    await waitFor(() => expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument())
  })
})
