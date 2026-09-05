/** 单测通过页码与键盘验证查询参数同步，真实滚轮与 scroll-snap 行为由 e2e 覆盖。 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
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

    // 服务端先修改第 2 组并递增版本，本地仍基于旧版修改第 1 组。
    touchMockShots(CONVERSATION_ID)
    const input = within(screen.getByRole('region', { name: '镜头组 1' })).getByRole('spinbutton', {
      name: '镜头组 1 的时长（秒）',
    })
    fireEvent.change(input, { target: { value: '8' } })

    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()
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

  it('点「生成视频」发一条出片任务：带这一组的描述、帧、时长与画幅，发完重拉任务列表', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    let posted: Record<string, unknown> = {}
    let reads = 0
    server.events.on('request:start', ({ request }) => {
      if (!request.url.includes('/api/generations')) return
      if (request.method === 'GET') reads += 1
      if (request.method === 'POST') {
        void request
          .clone()
          .json()
          .then((body: Record<string, unknown>) => {
            posted = body
          })
      }
    })
    await renderPanel('/?shot=1')
    await screen.findByText('3 组 · 合计 21 秒 · 第 1 组')
    const page = screen.getByRole('region', { name: '镜头组 1' })
    const readsBefore = reads

    await userEvent.click(within(page).getByRole('button', { name: '生成视频' }))

    await waitFor(() =>
      expect(posted).toMatchObject({
        aspectRatio: '9:16',
        conversationId: CONVERSATION_ID,
        durationSeconds: 6,
        kind: 'video',
        shotIndex: 1,
      }),
    )
    expect(posted['prompt']).toContain('模特提着帆布包走出门厅')
    expect(posted['imageUrls']).toHaveLength(1)
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore))
    expect(await within(page).findByRole('button', { name: '正在出片…' })).toBeDisabled()
  })

  it('这一组名下已经有在飞的任务：按钮就是「正在出片…」，点不动', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel('/?shot=2')

    const page = await screen.findByRole('region', { name: '镜头组 2' })
    expect(await within(page).findByRole('button', { name: '正在出片…' })).toBeDisabled()
  })

  it('描述还在保存的时候不许出片：别把没落盘的描述发出去', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    server.use(
      http.put('*/api/conversations/:id/workspace/file', async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    await renderPanel('/?shot=1')
    await screen.findByText('3 组 · 合计 21 秒 · 第 1 组')
    const page = screen.getByRole('region', { name: '镜头组 1' })
    fireEvent.change(within(page).getByRole('spinbutton', { name: '镜头组 1 的时长（秒）' }), {
      target: { value: '9' },
    })

    expect(await screen.findByText('保存中…', undefined, { timeout: 3000 })).toBeVisible()
    expect(within(page).getByRole('button', { name: '生成视频' })).toBeDisabled()
    expect(within(page).getByText('描述还在保存，存好了再出片')).toBeVisible()
  })

  it('描述没存下的时候不许出片，并说清原因', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    server.use(
      http.put('*/api/conversations/:id/workspace/file', () =>
        HttpResponse.json({ detail: '镜头组 1 的 seconds 要是 4-30 的整数' }, { status: 422 }),
      ),
    )
    await renderPanel('/?shot=1')
    await screen.findByText('3 组 · 合计 21 秒 · 第 1 组')
    const page = screen.getByRole('region', { name: '镜头组 1' })
    fireEvent.change(within(page).getByRole('spinbutton', { name: '镜头组 1 的时长（秒）' }), {
      target: { value: '9' },
    })

    await screen.findByRole('alert', undefined, { timeout: 3000 })
    expect(within(page).getByRole('button', { name: '生成视频' })).toBeDisabled()
    expect(within(page).getByText('描述没存下，先把它存下来再出片')).toBeVisible()
  })

  it('画幅不在出片支持的档位里：按钮点不动并说明原因', async () => {
    server.use(
      http.get('*/api/conversations/:conversationId/workspace/file', () =>
        HttpResponse.json({
          file: {
            content: JSON.stringify({
              aspectRatio: '5:4',
              shots: [{ imageUrls: ['a.png'], index: 1, prompt: '一段描述 @Image1。', seconds: 6 }],
            }),
            path: SHOTS_MOCK_PATH,
            version: 1,
          },
        }),
      ),
    )
    await renderPanel('/?shot=1')

    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).getByRole('button', { name: '生成视频' })).toBeDisabled()
    expect(within(page).getByText(/画幅 5:4 不在出片支持的档位里/)).toBeVisible()
  })

  it('「全部分镜」开浮层、写进地址，点一张卡翻到那一组', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=1')
    await screen.findByText('3 组 · 合计 21 秒 · 第 1 组')

    await userEvent.click(screen.getByRole('button', { name: '全部分镜' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ sheet: 'all', shot: 1 }))

    const sheet = screen.getByRole('complementary', { name: '全部分镜' })
    await userEvent.click(within(sheet).getByText(/低角度拍鞋面/))

    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 3 }))
  })

  it('批量出片：确认之后逐组发，已经在飞的那一组跳过', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const posted: number[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method !== 'POST' || !request.url.includes('/api/generations')) return
      void request
        .clone()
        .json()
        .then((body: { shotIndex: number }) => {
          posted.push(body.shotIndex)
        })
    })
    await renderPanel('/?shot=1&sheet=all')

    const sheet = await screen.findByRole('complementary', { name: '全部分镜' })
    await userEvent.click(within(sheet).getByRole('button', { name: '全选' }))
    await userEvent.click(within(sheet).getByRole('button', { name: '生成选中的 3 组' }))
    const dialog = await screen.findByRole('dialog', { name: '确认批量出片' })
    await userEvent.click(within(dialog).getByRole('button', { name: '发出去' }))

    await waitFor(() => expect(posted).toEqual([1, 3]))
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
