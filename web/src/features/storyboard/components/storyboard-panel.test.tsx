/** 单测通过页码与键盘验证查询参数同步，真实滚轮与 scroll-snap 行为由 e2e 覆盖。 */

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { pasteTextIntoComposer } from '@/testing/editor'
import { server } from '@/testing/mocks/server'
import { seedMockWorkspace, SHOTS_MOCK_PATH, touchMockShots } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import type { ShotsDocument } from '../shots'
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

const editDescription = (editor: HTMLElement, text = '镜头缓慢推进。') => {
  editor.focus()
  pasteTextIntoComposer(editor, text)
}

const sceneNavigation = (page: HTMLElement) =>
  within(page).getByRole('navigation', { name: '本组镜头' })

const provideDocument = (document: ShotsDocument) => {
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/file', () =>
      HttpResponse.json({
        file: { content: JSON.stringify(document), path: SHOTS_MOCK_PATH, version: 1 },
      }),
    ),
  )
}

const fsChanged = {
  payload: {
    changes: [{ change: 'modified', kind: 'file', path: SHOTS_MOCK_PATH }],
    coalesced_window_ms: 0,
  },
  session_id: CONVERSATION_ID,
  type: 'event.fs.changed',
}

describe('StoryboardPanel', () => {
  it('常态只保留生成记录与导航入口，不展示组统计、状态和时长输入', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()

    expect(await screen.findByRole('region', { name: '镜头组 1' })).toBeVisible()
    expect(screen.getAllByRole('region', { name: /镜头组 \d/ })).toHaveLength(3)
    expect(screen.getByRole('button', { name: '生成记录' })).toBeVisible()
    expect(screen.queryByText(/合计.*秒/)).not.toBeInTheDocument()
    expect(screen.queryByText('还没出片')).not.toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })

  it('点页码点翻到那一组，组号进地址', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(screen.getByRole('button', { name: '第 2 组' })).toHaveAttribute('aria-current', 'true')
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

    await screen.findByRole('region', { name: '镜头组 2' })
    await userEvent.click(screen.getByRole('button', { name: '第 1 组' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 1 }))
  })

  it('点描述里的帧芯片把帧号写进地址', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2&frame=3')

    const page = await screen.findByRole('region', { name: '镜头组 2' })
    await userEvent.click(within(page).getByRole('button', { name: '看第 2 帧' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 2, shot: 2 }))
  })

  it('同行镜头正文正确识别，只编辑当前镜头，选中首帧卡片在原位展开全部帧', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2')

    const page = await screen.findByRole('region', { name: '镜头组 2' })
    expect(within(page).getByRole('textbox', { name: '镜头 1 的描述' })).toHaveTextContent(
      '她从长椅间走向镜头',
    )
    expect(within(page).queryByRole('textbox', { name: '镜头 2 的描述' })).not.toBeInTheDocument()
    expect(within(page).queryByText(/参考锁定/)).not.toBeInTheDocument()
    const navigation = sceneNavigation(page)
    expect(within(navigation).getAllByRole('group')).toHaveLength(2)
    const secondShot = within(navigation).getByRole('group', { name: '镜头 2' })
    const firstFrameUrl = within(secondShot)
      .getByRole('img', { name: '镜头 2 首帧' })
      .getAttribute('src')
    await userEvent.click(within(secondShot).getByRole('button', { name: '镜头 2' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 2, shot: 2 }))
    expect(secondShot).toHaveAttribute('aria-current', 'true')
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '再低头看一眼包',
    )
    expect(within(page).queryByRole('textbox', { name: '镜头 1 的描述' })).not.toBeInTheDocument()
    expect(within(page).getByRole('img', { name: '镜头组 2 第 2 帧' })).toHaveAttribute(
      'src',
      firstFrameUrl,
    )
    expect(
      within(secondShot)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['预览第 2 帧', '预览第 3 帧'])
    expect(within(secondShot).getByRole('button', { name: '预览第 2 帧' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await userEvent.click(within(secondShot).getByRole('button', { name: '预览第 3 帧' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 3, shot: 2 }))
    expect(within(page).getByRole('img', { name: '镜头组 2 第 3 帧' })).not.toHaveAttribute(
      'src',
      firstFrameUrl,
    )
    expect(within(secondShot).getAllByRole('button')[0]?.querySelector('img')).toHaveAttribute(
      'src',
      firstFrameUrl,
    )
    expect(secondShot).toHaveAttribute('aria-current', 'true')
    expect(within(secondShot).getByRole('button', { name: '预览第 3 帧' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(secondShot).getByRole('button', { name: '预览第 2 帧' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(within(navigation).getByRole('button', { name: '镜头 1' })).toBeVisible()

    await userEvent.click(within(page).getByRole('button', { name: '打开原图' }))
    const lightbox = screen.getByRole('dialog', { name: '镜头组 2 第 3 帧' })
    expect(within(lightbox).getByRole('img')).toHaveAttribute(
      'src',
      within(secondShot)
        .getByRole('button', { name: '预览第 3 帧' })
        .querySelector('img')
        ?.getAttribute('src'),
    )
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '镜头组 2 第 3 帧' })).not.toBeInTheDocument()
  })

  it('没有可识别镜头标题时，仍展示本组所有图片并可切换未被描述引用的帧', async () => {
    const imageUrls = ['https://example.com/frame-1.png', 'https://example.com/frame-2.png']
    server.use(
      http.get('*/api/conversations/:conversationId/workspace/file', () =>
        HttpResponse.json({
          file: {
            content: JSON.stringify({
              aspectRatio: '9:16',
              shots: [{ imageUrls, index: 1, prompt: '模特走向镜头 @Image1。', seconds: 6 }],
            }),
            path: SHOTS_MOCK_PATH,
            version: 1,
          },
        }),
      ),
    )
    const { router } = await renderPanel('/?shot=1')

    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const allFrames = within(page).getByRole('navigation', { name: '本组全部帧' })
    expect(within(allFrames).getAllByRole('button')).toHaveLength(2)
    expect(within(allFrames).getByRole('button', { name: '预览第 1 帧' })).toBeVisible()
    await userEvent.click(within(allFrames).getByRole('button', { name: '预览第 2 帧' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 2, shot: 1 }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      imageUrls[1],
    )
  })

  it('展开帧按正文引用顺序去重，帧号不决定首帧的位置', async () => {
    provideDocument({
      aspectRatio: '9:16',
      shots: [
        {
          imageUrls: ['one.png', 'two.png', 'three.png'],
          index: 1,
          prompt:
            '[0–2秒｜镜头1] 开场 @Image1。\n[2–6秒｜镜头2] 特写 @Image3，回看 @Image2，再回特写 @Image3。',
          seconds: 6,
        },
      ],
    })
    await renderPanel('/?shot=1&frame=3')

    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const scene = within(sceneNavigation(page)).getByRole('group', { name: '镜头 2' })
    expect(
      within(scene)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['预览第 3 帧', '预览第 2 帧'])
  })

  it('两个镜头共用首帧时，点击第二镜头仍展开第二镜头并显示它的正文', async () => {
    provideDocument({
      aspectRatio: '9:16',
      shots: [
        {
          imageUrls: ['shared.png', 'ending.png'],
          index: 1,
          prompt:
            '[0–2秒｜镜头1] 开场 @Image1。\n[2–6秒｜镜头2] 同一首帧继续 @Image1，然后收尾 @Image2。',
          seconds: 6,
        },
      ],
    })
    await renderPanel('/?shot=1')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const navigation = sceneNavigation(page)
    await userEvent.click(within(navigation).getByRole('button', { name: '镜头 2' }))

    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '同一首帧继续',
    )
    expect(within(navigation).getByRole('group', { name: '镜头 2' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(navigation).getByRole('group', { name: '镜头 1' })).toHaveAttribute(
      'aria-current',
      'false',
    )
    expect(within(navigation).getByRole('button', { name: '预览第 1 帧' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(navigation).getByRole('button', { name: '预览第 2 帧' })).toBeVisible()
  })

  it.each([
    { imageUrls: ['one.png'], name: '单帧', prompt: '[0–6秒｜镜头1] 开场 @Image1。' },
    { imageUrls: [], name: '无帧', prompt: '[0–6秒｜镜头1] 等待镜头图片。' },
  ])('$name 镜头仍能显示描述与导航', async ({ imageUrls, prompt }) => {
    provideDocument({ aspectRatio: '9:16', shots: [{ imageUrls, index: 1, prompt, seconds: 6 }] })
    await renderPanel('/?shot=1')

    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).getByRole('textbox', { name: '镜头 1 的描述' })).toBeVisible()
    expect(within(sceneNavigation(page)).getByRole('group', { name: '镜头 1' })).toBeVisible()
    expect(within(page).getByRole('button', { name: '上一帧' })).toBeDisabled()
    expect(within(page).getByRole('button', { name: '下一帧' })).toBeDisabled()
    if (imageUrls.length === 0) {
      expect(within(page).getByRole('button', { name: '删掉这一帧' })).toBeDisabled()
      expect(within(page).queryByRole('button', { name: '预览第 1 帧' })).not.toBeInTheDocument()
    } else {
      expect(within(page).getByRole('button', { name: '预览第 1 帧' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    }
  })

  it('删除当前镜头首帧后，下一张递补首帧且仍关联当前镜头', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 2' })
    const scene = within(sceneNavigation(page)).getByRole('group', { name: '镜头 2' })
    const nextFrameUrl = within(scene)
      .getByRole('button', { name: '预览第 3 帧' })
      .querySelector('img')
      ?.getAttribute('src')

    await userEvent.click(within(page).getByRole('button', { name: '删掉这一帧' }))

    await waitFor(() => expect(router.state.location.search).toEqual({ frame: 2, shot: 2 }))
    expect(scene).toHaveAttribute('aria-current', 'true')
    expect(within(scene).getAllByRole('button')).toHaveLength(1)
    expect(
      within(scene).getByRole('button', { name: '预览第 2 帧' }).querySelector('img'),
    ).toHaveAttribute('src', nextFrameUrl)
    expect(within(page).getByRole('img', { name: '镜头组 2 第 2 帧' })).toHaveAttribute(
      'src',
      nextFrameUrl,
    )
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '再低头看一眼包 @2',
    )
    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()
  })

  it('无帧镜头可选中查看描述，未关联图片仍可独立预览且不沿用别的镜头正文', async () => {
    provideDocument({
      aspectRatio: '9:16',
      shots: [
        {
          imageUrls: ['one.png', 'unassigned.png'],
          index: 1,
          prompt: '[0–2秒｜镜头1] 开场 @Image1。\n[2–6秒｜镜头2] 这里只有旁白。',
          seconds: 6,
        },
      ],
    })
    await renderPanel('/?shot=1')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const navigation = sceneNavigation(page)
    await userEvent.click(within(navigation).getByRole('button', { name: '镜头 2' }))

    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '这里只有旁白。',
    )
    expect(within(page).queryByRole('img', { name: '镜头组 1 第 1 帧' })).not.toBeInTheDocument()
    expect(within(page).getByRole('button', { name: '删掉这一帧' })).toBeDisabled()

    await userEvent.click(within(navigation).getByRole('button', { name: '预览第 2 帧' }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'unassigned.png',
    )
    expect(within(page).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('选择无帧镜头后仍跟随外部帧导航，切组回来不会残留局部镜头选择', async () => {
    provideDocument({
      aspectRatio: '9:16',
      shots: [
        {
          imageUrls: ['one.png', 'two.png'],
          index: 1,
          prompt:
            '[0–2秒｜镜头1] 开场 @Image1。\n[2–4秒｜镜头2] 这里只有旁白。\n[4–6秒｜镜头3] 收尾 @Image2。',
          seconds: 6,
        },
        {
          imageUrls: ['other.png'],
          index: 2,
          prompt: '[0–4秒｜镜头1] 下一组 @Image1。',
          seconds: 4,
        },
      ],
    })
    const { router } = await renderPanel('/?shot=1')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(sceneNavigation(page)).getByRole('button', { name: '镜头 2' }))
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toBeVisible()

    await act(async () => {
      await router.navigate({ href: '/?shot=1&frame=2' })
    })
    expect(within(page).getByRole('textbox', { name: '镜头 3 的描述' })).toBeVisible()
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'two.png',
    )

    await userEvent.click(within(sceneNavigation(page)).getByRole('button', { name: '镜头 2' }))
    await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))
    await userEvent.click(screen.getByRole('button', { name: '第 1 组' }))
    const returnedPage = screen.getByRole('region', { name: '镜头组 1' })
    expect(within(returnedPage).getByRole('textbox', { name: '镜头 1 的描述' })).toBeVisible()
    expect(within(returnedPage).getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
      'src',
      'one.png',
    )
  })

  it('「生成记录」开抽屉、写进地址，✕ 关掉', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel('/?shot=2')

    await screen.findByRole('region', { name: '镜头组 2' })
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
    const { socket } = await renderPanel('/?shot=2&frame=2')

    await screen.findByRole('textbox', { name: '镜头 2 的描述' })
    expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument()

    touchMockShots(CONVERSATION_ID)
    socket.deliver(fsChanged)

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
        '台词并成一句',
      ),
    )
    expect(screen.getByText('agent 刚改过')).toBeVisible()
  })

  it('编辑当前镜头停手即存，原样保留前言、其他镜头和组时长', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    let original: ShotsDocument | undefined
    let written: { expectedVersion?: number; content?: string } = {}
    server.events.on('response:mocked', ({ request, response }) => {
      if (request.method === 'GET' && request.url.includes(`path=${SHOTS_MOCK_PATH}`)) {
        void response
          .clone()
          .json()
          .then((body: { file: { content: string } }) => {
            original ??= JSON.parse(body.file.content) as ShotsDocument
          })
      }
    })
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
    await renderPanel('/?shot=2&frame=2')
    await screen.findByRole('textbox', { name: '镜头 2 的描述' })

    const editor = within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('textbox', {
      name: '镜头 2 的描述',
    })
    editDescription(editor)

    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()
    expect(written.expectedVersion).toBe(1)
    expect(original).toBeDefined()
    const saved = JSON.parse(written.content ?? '{}') as ShotsDocument
    expect(saved.shots[1]?.prompt).toContain('镜头缓慢推进。')
    expect({
      ...saved,
      shots: saved.shots.map((shot) =>
        shot.index === 2 ? { ...shot, prompt: shot.prompt.replace('镜头缓慢推进。', '') } : shot,
      ),
    }).toEqual(original)
    expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument()
  })

  it('删光当前镜头帧引用后仍可继续编辑、撤销并保存，前言和其他镜头保持不变', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const originalPrompt =
      '参考锁定：服装一致 @Image1。\n[0–2秒｜镜头1] 开场 @Image1。\n[2–6秒｜镜头2] 原来的镜头 @Image2。'
    const original: ShotsDocument = {
      aspectRatio: '9:16',
      shots: [{ imageUrls: ['one.png', 'two.png'], index: 1, prompt: originalPrompt, seconds: 6 }],
    }
    provideDocument(original)
    let written: ShotsDocument | undefined
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PUT' && request.url.includes('/workspace/file')) {
        void request
          .clone()
          .json()
          .then((body: { content: string }) => {
            written = JSON.parse(body.content) as ShotsDocument
          })
      }
    })
    await renderPanel('/?shot=1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const editor = within(page).getByRole('textbox', { name: '镜头 2 的描述' })
    editor.focus()
    await userEvent.keyboard('{Control>}a{/Control}')
    pasteTextIntoComposer(editor, '新镜头描述。')

    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '新镜头描述。',
    )
    expect(within(page).queryByRole('button', { name: '看第 2 帧' })).not.toBeInTheDocument()
    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()

    editDescription(within(page).getByRole('textbox', { name: '镜头 2 的描述' }), '继续推进。')
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '新镜头描述。继续推进。',
    )
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '新镜头描述。',
    )
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).not.toHaveTextContent(
      '继续推进。',
    )
    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()
    expect(written).toEqual({
      ...original,
      shots: original.shots.map((shot) => ({
        ...shot,
        prompt: originalPrompt.replace('原来的镜头 @Image2。', '新镜头描述。'),
      })),
    })
  })

  it('版本撞车但改的不是同一组：重放我的改动到最新版上再存', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel('/?shot=1')
    await screen.findByRole('region', { name: '镜头组 1' })

    // 服务端先修改第 2 组并递增版本，本地仍基于旧版修改第 1 组。
    touchMockShots(CONVERSATION_ID)
    const editor = within(screen.getByRole('region', { name: '镜头组 1' })).getByRole('textbox', {
      name: '镜头 1 的描述',
    })
    editDescription(editor)

    expect(await screen.findByText('已保存', undefined, { timeout: 3000 })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))
    await userEvent.click(
      within(sceneNavigation(screen.getByRole('region', { name: '镜头组 2' }))).getByRole(
        'button',
        { name: '镜头 2' },
      ),
    )
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
        '台词并成一句',
      ),
    )
  })

  it('两边改了同一组：弹出选择，选「用最新的」就丢掉我的', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel('/?shot=2&frame=2')
    await screen.findByRole('textbox', { name: '镜头 2 的描述' })

    touchMockShots(CONVERSATION_ID)
    const editor = within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('textbox', {
      name: '镜头 2 的描述',
    })
    editDescription(editor)

    const dialog = await screen.findByRole(
      'dialog',
      { name: '这一组有别的改动' },
      { timeout: 3000 },
    )
    expect(dialog).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: '用最新的' }))

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
        '台词并成一句',
      ),
    )
    expect(
      within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('textbox', {
        name: '镜头 2 的描述',
      }),
    ).not.toHaveTextContent('镜头缓慢推进。')
  })

  it('形状不合规存不下去：原文照实显示', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    server.use(
      http.put('*/api/conversations/:id/workspace/file', () =>
        HttpResponse.json({ detail: '镜头组 2 的描述未通过校验' }, { status: 422 }),
      ),
    )
    await renderPanel('/?shot=2&frame=2')
    await screen.findByRole('textbox', { name: '镜头 2 的描述' })

    const editor = within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('textbox', {
      name: '镜头 2 的描述',
    })
    editDescription(editor)

    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '没存下',
    )
  })

  it('点「生成视频」发一条出片任务：带这一组的描述、帧、时长与画幅，发完重拉任务列表', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const prompt =
      '参考锁定：服装始终一致。\n[0–2秒｜镜头1] 开场 @Image1。\n[2–6秒｜镜头2] 特写 @Image2，收尾 @Image3。'
    const imageUrls = ['one.png', 'two.png', 'three.png']
    provideDocument({ aspectRatio: '9:16', shots: [{ imageUrls, index: 1, prompt, seconds: 6 }] })
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
    await renderPanel('/?shot=1&frame=2')
    await screen.findByRole('region', { name: '镜头组 1' })
    const page = screen.getByRole('region', { name: '镜头组 1' })
    const readsBefore = reads
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toBeVisible()
    expect(within(page).queryByRole('textbox', { name: '镜头 1 的描述' })).not.toBeInTheDocument()

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
    expect(posted['prompt']).toBe(prompt)
    expect(posted['imageUrls']).toEqual(imageUrls)
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
    await screen.findByRole('region', { name: '镜头组 1' })
    const page = screen.getByRole('region', { name: '镜头组 1' })
    editDescription(within(page).getByRole('textbox', { name: '镜头 1 的描述' }))

    expect(await screen.findByText('保存中…', undefined, { timeout: 3000 })).toBeVisible()
    expect(within(page).getByRole('button', { name: '生成视频' })).toBeDisabled()
    expect(within(page).getByText('描述还在保存，存好了再出片')).toBeVisible()
  })

  it('描述没存下的时候不许出片，并说清原因', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    server.use(
      http.put('*/api/conversations/:id/workspace/file', () =>
        HttpResponse.json({ detail: '镜头组 1 的描述未通过校验' }, { status: 422 }),
      ),
    )
    await renderPanel('/?shot=1')
    await screen.findByRole('region', { name: '镜头组 1' })
    const page = screen.getByRole('region', { name: '镜头组 1' })
    editDescription(within(page).getByRole('textbox', { name: '镜头 1 的描述' }))

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
    await screen.findByRole('region', { name: '镜头组 1' })

    await userEvent.click(
      within(screen.getByRole('region', { name: '镜头组 1' })).getByRole('button', {
        name: '全部分镜',
      }),
    )
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
    const { socket } = await renderPanel('/?shot=2&frame=2')

    await screen.findByRole('textbox', { name: '镜头 2 的描述' })
    touchMockShots(CONVERSATION_ID)
    socket.deliver(fsChanged)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
        '台词并成一句',
      ),
    )

    await userEvent.click(screen.getByRole('button', { name: '第 3 组' }))

    await waitFor(() => expect(screen.queryByText('agent 刚改过')).not.toBeInTheDocument())
  })
})
