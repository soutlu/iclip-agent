import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { pasteTextIntoComposer } from '@/testing/editor'
import { workspaceQueryKeys, type ArtifactRendererProps } from '@/shared/workbench'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ShotsDocument } from '../shot-document'
import type { GenerationJob } from '../storyboard.api'
import { StoryboardReader } from './storyboard-reader'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
const PATH = 'video_shot.json'
const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${PATH}`,
  source: { kind: 'file', path: PATH, version: 1 },
  title: '分镜',
  type: 'storyboard',
}

const document: ShotsDocument = {
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      seconds: 8,
      image_urls: [
        'https://example.com/one.png',
        'https://example.com/two.png',
        'https://example.com/unassigned.png',
      ],
      prompt: {
        global_settings: '  人物和产品保持一致。\n剪辑形式：硬切。\n',
        timeline: [
          {
            timestamps: [0, 2.5],
            prompt: '  模特走出门厅 @Image2，再看向鞋面 @Image1。\n',
            image_indexes: [2, 1],
          },
          {
            timestamps: [3.25, 5],
            prompt: '共用同一帧继续动作 @Image2，再次看向 @Image1。',
            image_indexes: [2, 1],
          },
          { timestamps: [5, 6], prompt: '这里保留旁白，没有图片引用。', image_indexes: [] },
        ],
      },
    },
    {
      index: 2,
      seconds: 4,
      image_urls: ['https://example.com/other-group.png'],
      prompt: {
        global_settings: '第二组保持固定机位。',
        timeline: [
          { timestamps: [0, 4], prompt: '第二组展示穿着效果 @Image1。', image_indexes: [1] },
        ],
      },
    },
  ],
}

const jobs: GenerationJob[] = [
  {
    id: 'aba2268d-b27b-4fb5-a592-d952f4483b88',
    createdAt: '2026-09-01T10:00:00Z',
    errorMessage: null,
    kind: 'video',
    outputUrl: 'https://example.com/take.mp4',
    request: { prompt: '本组生成时使用的历史描述。' },
    shotIndex: 1,
    status: 'completed',
    taskId: null,
    watermarkOutputUrl: null,
  },
  {
    id: 'cdf9d301-fe78-4c9b-a4f7-c936621179f0',
    createdAt: '2026-09-01T10:01:00Z',
    errorMessage: null,
    kind: 'video',
    outputUrl: null,
    request: { prompt: '另一组的历史描述。' },
    shotIndex: 2,
    status: 'completed',
    taskId: null,
    watermarkOutputUrl: null,
  },
]

/** 一条带结构化 shot 的历史记录，可以回填镜头组；正文是服务端从 shot 拼出来的。 */
const historyPrompt = [
  '历史版参考锁定：人物和产品保持一致。',
  '剪辑形式：硬切。',
  '',
  '[0–2.5秒｜镜头1] 历史版：模特走出门厅 @Image2。',
  '[2.5–6秒｜镜头2] 历史版：转身看向鞋面 @Image1。',
  '不要生成字幕，不要生成背景音乐。',
].join('\n')

const historyShot = {
  global_settings: '  历史版参考锁定：人物和产品保持一致。\n剪辑形式：硬切。\n',
  timeline: [
    { image_indexes: [2], prompt: '  历史版：模特走出门厅 @Image2。\n', timestamps: [0, 2.5] },
    { image_indexes: [1], prompt: '历史版：转身看向鞋面 @Image1。', timestamps: [2.5, 6] },
  ],
}

const editableJob: GenerationJob = {
  id: 'e5b1c0de-6c1e-4f1a-9b3d-8c0a1f2e3d40',
  createdAt: '2026-09-01T10:02:00Z',
  errorMessage: null,
  kind: 'video',
  outputUrl: 'https://example.com/history.mp4',
  request: { prompt: historyPrompt, shot: historyShot },
  shotIndex: 1,
  status: 'completed',
  taskId: null,
  watermarkOutputUrl: null,
}

/** 刚提交、还在跑的那一条，服务端刷新列表时才会出现。 */
const runningJob: GenerationJob = {
  id: 'b7e0f4c2-3d1a-4e5b-9c6d-7e8f9a0b1c2d',
  createdAt: '2026-09-01T10:03:00Z',
  errorMessage: null,
  kind: 'video',
  outputUrl: null,
  request: { prompt: '刚提交的这一版。' },
  shotIndex: 1,
  status: 'submitted',
  taskId: null,
  watermarkOutputUrl: null,
}

const provide = (content: ShotsDocument | string = document, version = 1) => {
  let stored = typeof content === 'string' ? content : JSON.stringify(content)
  let storedVersion = version
  let failure: string | undefined
  const writes: { content: string; expectedVersion: number }[] = []
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/files', () =>
      HttpResponse.json({ files: [{ path: PATH, version: storedVersion }] }),
    ),
    http.get('*/api/conversations/:conversationId/workspace/file', () =>
      HttpResponse.json({ file: { content: stored, path: PATH, version: storedVersion } }),
    ),
    http.put('*/api/conversations/:conversationId/workspace/file', async ({ request }) => {
      const body = (await request.json()) as { content: string; expectedVersion: number }
      writes.push(body)
      if (failure !== undefined) return HttpResponse.json({ detail: failure }, { status: 503 })
      if (body.expectedVersion !== storedVersion)
        return HttpResponse.json({ detail: '版本冲突' }, { status: 409 })
      stored = body.content
      storedVersion += 1
      return HttpResponse.json({ file: { content: stored, path: PATH, version: storedVersion } })
    }),
    http.get('*/api/generations', () => HttpResponse.json({ items: jobs })),
  )
  return {
    writes,
    snapshot: () => JSON.parse(stored) as ShotsDocument,
    failSave: (message: string | undefined) => {
      failure = message
    },
  }
}

const emptyDocument: ShotsDocument = {
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      image_urls: [],
      seconds: 6,
      prompt: {
        global_settings: '人物和场景保持一致。',
        timeline: [
          { timestamps: [0, 3], prompt: '无图镜头一。', image_indexes: [] },
          { timestamps: [3, 6], prompt: '无图镜头二。', image_indexes: [] },
        ],
      },
    },
  ],
}

const imageFile = () => new File(['image bytes'], '新帧.png', { type: 'image/png' })
const replaceText = async (editor: HTMLElement, text: string) => {
  editor.focus()
  await userEvent.keyboard('{Control>}a{/Control}')
  pasteTextIntoComposer(editor, text)
}
const delayedUpload = () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  server.use(
    http.put('*/mock-oss/:assetId', async () => {
      await pending
      return new HttpResponse(null, { status: 200 })
    }),
  )
  return release
}

const renderReader = (initialPath = '/?shot=1&content=scene:1') =>
  renderWithProviders(
    <>
      <StoryboardReader artifact={artifact} conversationId={CONVERSATION_ID} />
      <Toaster />
    </>,
    {
      initialPath,
    },
  )

const navigationOf = (page: HTMLElement) =>
  within(page).getByRole('navigation', { name: '本组镜头' })

describe('StoryboardReader', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => {
    toast.dismiss()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  it('按结构读取图片顺序、首帧与单镜正文，保留小数时长', async () => {
    provide()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'https://example.com/two.png',
    )
    expect(within(page).getByRole('textbox', { name: '镜头 1 的描述' }).textContent).toBe(
      '  模特走出门厅 @2，再看向鞋面 @1。',
    )
    expect(within(page).queryByText('人物和产品保持一致。')).not.toBeInTheDocument()
    expect(within(page).queryByRole('textbox', { name: '镜头 2 的描述' })).not.toBeInTheDocument()
    const first = within(navigationOf(page)).getByRole('group', { name: '镜头 1' })
    expect(
      within(first)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['预览第 2 帧', '预览第 1 帧'])
    expect(within(first).getByText('2.5s')).toBeVisible()
    expect(within(navigationOf(page)).getAllByRole('group')).toHaveLength(5)
  })

  it('共用帧时明确选择第二镜，切缩略帧、帧标记和箭头仍保留该镜头', async () => {
    provide()
    const { router } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const navigation = navigationOf(page)
    await userEvent.click(within(navigation).getByRole('button', { name: '镜头 2' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2', frame: 2 }),
    )
    const second = within(navigation).getByRole('group', { name: '镜头 2' })
    await userEvent.click(within(second).getByRole('button', { name: '预览第 1 帧' }))
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '共用同一帧继续动作',
    )
    expect(second).toHaveAttribute('aria-current', 'true')
    await userEvent.click(within(page).getByRole('button', { name: '看第 2 帧' }))
    await userEvent.click(within(page).getByRole('button', { name: '上一帧' }))
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toBeVisible()
    expect(within(navigation).getByRole('group', { name: '镜头 1' })).toHaveAttribute(
      'aria-current',
      'false',
    )
  })

  it('无帧镜头可查看正文，未关联图片可独立预览，外部导航清除局部镜头选择', async () => {
    provide()
    const { router } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const navigation = navigationOf(page)
    await userEvent.click(within(navigation).getByRole('button', { name: '镜头 3' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:3' }),
    )
    expect(within(page).getByRole('textbox', { name: '镜头 3 的描述' })).toHaveTextContent(
      '这里保留旁白',
    )
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    await userEvent.click(within(navigation).getByRole('button', { name: '未引用' }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 3 帧' })).toHaveAttribute(
      'src',
      'https://example.com/unassigned.png',
    )
    expect(within(page).queryByRole('textbox', { name: /镜头 \d 的描述/ })).not.toBeInTheDocument()
    await act(async () => {
      await router.navigate({ href: '/?shot=1&content=scene:1&frame=1' })
    })
    expect(within(page).getByRole('textbox', { name: '镜头 1 的描述' })).toBeVisible()
  })

  it('帧箭头沿当前内容引用顺序导航，换组时默认选中全局设定', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 1 }),
    )
    expect(within(page).getByRole('button', { name: '下一帧' })).toBeDisabled()
    screen.getByRole('button', { name: '第 1 组' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(screen.getByRole('button', { name: '第 2 组' })).toHaveAttribute('aria-current', 'true')
    expect(
      within(screen.getByRole('region', { name: '镜头组 2' })).getByRole('textbox', {
        name: '全局设定',
      }),
    ).toBeVisible()
  })

  it('查看原图并关闭后返回原来的帧', async () => {
    provide()
    await renderReader('/?shot=1&content=scene:1&frame=1')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const trigger = within(page).getByRole('button', { name: '打开原图' })
    await userEvent.click(trigger)
    const lightbox = await screen.findByRole('dialog', { name: '镜头组 1 第 1 帧' })
    expect(within(lightbox).getByRole('img')).toHaveAttribute('src', 'https://example.com/one.png')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('完整提示词展示原始全局设定、时间戳和正文，并按原顺序显示全部参考图', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const trigger = within(page).getByRole('button', { name: '完整提示词' })
    await userEvent.click(trigger)
    const sheet = await screen.findByRole('complementary', { name: '镜头组完整提示词' })
    const original = document.shots[0]
    expect(within(sheet).getByLabelText('全局设定').textContent).toBe(
      original?.prompt.global_settings.replaceAll('\n', ''),
    )
    const second = within(sheet).getByRole('region', { name: '镜头 2 原文' })
    expect(within(second).getByRole('heading').textContent).toBe('[3.25–5秒｜镜头2]')
    expect(second.querySelector('p')?.textContent).toBe(original?.prompt.timeline[1]?.prompt)
    expect(
      within(within(sheet).getByRole('region', { name: '本组参考图' }))
        .getAllByRole('img')
        .map((image) => image.getAttribute('src')),
    ).toEqual(original?.image_urls)
    expect(router.state.location.search).toEqual({
      shot: 1,
      content: 'scene:1',
      frame: 2,
      sheet: 'prompt',
    })
    await userEvent.click(within(sheet).getByRole('button', { name: '收起完整提示词' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 2 }),
    )
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('全部组概览可定位镜头组，记录只显示当前组', async () => {
    provide()
    const { router } = await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(screen.getByRole('button', { name: '全部镜头组' }))
    const overview = await screen.findByRole('complementary', { name: '全部镜头组' })
    expect(within(overview).getAllByRole('listitem')).toHaveLength(2)
    await userEvent.click(within(overview).getByRole('button', { name: '查看镜头组 2' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    await userEvent.click(screen.getByRole('button', { name: '生成记录' }))
    const records = await screen.findByRole('complementary', { name: '生成记录' })
    expect(await within(records).findByText('另一组的历史描述。')).toBeVisible()
    expect(within(records).queryByText('本组生成时使用的历史描述。')).not.toBeInTheDocument()
  })

  it('编辑生成把历史记录里的镜头组回填到当前组并保存', async () => {
    const files = provide()
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [editableJob] })))
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(screen.getByRole('button', { name: '生成记录' }))
    const records = await screen.findByRole('complementary', { name: '生成记录' })
    await userEvent.click(within(records).getByRole('button', { name: '编辑生成' }))
    expect(await screen.findByText('历史提示词已回填到当前镜头组')).toBeVisible()

    await waitFor(() => expect(files.writes).toHaveLength(1))
    const saved = JSON.parse(files.writes[0]?.content ?? '{}') as ShotsDocument
    expect(saved.shots[0]?.prompt).toEqual({
      global_settings: '  历史版参考锁定：人物和产品保持一致。\n剪辑形式：硬切。\n',
      timeline: [
        {
          timestamps: [0, 2.5],
          prompt: '  历史版：模特走出门厅 @Image2。\n',
          image_indexes: [2],
        },
        {
          timestamps: [2.5, 6],
          prompt: '历史版：转身看向鞋面 @Image1。',
          image_indexes: [1],
        },
      ],
    })
    // 图片跟着文档，不跟历史记录。
    expect(saved.shots[0]?.image_urls).toEqual(document.shots[0]?.image_urls)
  })

  it('浏览与记录查看不会触发写入', async () => {
    provide()
    const requests: { method: string; url: string }[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/api/')) requests.push({ method: request.method, url: request.url })
    })
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).getByRole('textbox', { name: '镜头 1 的描述' })).toBeVisible()
    await userEvent.click(within(page).getByRole('button', { name: '完整提示词' }))
    const prompt = await screen.findByRole('complementary', { name: '镜头组完整提示词' })
    expect(within(prompt).getByRole('button', { name: '复制完整提示词' })).toBeVisible()
    await userEvent.click(within(prompt).getByRole('button', { name: '收起完整提示词' }))
    await userEvent.click(screen.getByRole('button', { name: '生成记录' }))
    const records = await screen.findByRole('complementary', { name: '生成记录' })
    await within(records).findByText('本组生成时使用的历史描述。')
    expect(
      within(records).queryByRole('button', { name: /生成视频|编辑图片/ }),
    ).not.toBeInTheDocument()
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([])
  })

  it('生成任务帧到了立刻重拉记录，不等轮询', async () => {
    provide()
    let served = 0
    server.use(
      http.get('*/api/generations', () => {
        served += 1
        const finished = {
          ...runningJob,
          outputUrl: 'https://example.com/new.mp4',
          status: 'completed',
        }
        return HttpResponse.json({ items: [served === 1 ? runningJob : finished] })
      }),
    )
    const { socket } = await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(screen.getByRole('button', { name: '生成记录' }))
    const records = await screen.findByRole('complementary', { name: '生成记录' })
    expect(await within(records).findByText('生成中…')).toBeVisible()

    act(() => {
      socket.deliver({
        type: 'event.generation.changed',
        session_id: CONVERSATION_ID,
        payload: { id: runningJob.id, kind: 'video', status: 'completed', shot_index: 1 },
      })
    })

    expect(await within(records).findByText('生成完成')).toBeVisible()
    expect(served).toBe(2)
  })

  it.each([
    { action: '关闭生成记录', items: jobs, label: '记录列表关闭' },
    { action: '返回分镜', items: [], label: '空态返回分镜' },
  ])('$label 后恢复分镜和路由，保留原文且不保存', async ({ action, items }) => {
    const files = provide()
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items })))
    const { router } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const description = within(page).getByRole('textbox', { name: '镜头 1 的描述' })
    const originalText = description.textContent
    await userEvent.click(screen.getByRole('button', { name: '生成记录' }))
    const records = await screen.findByRole('complementary', { name: '生成记录' })
    if (items.length === 0) expect(await within(records).findByText('暂无视频记录')).toBeVisible()
    else await within(records).findByText('本组生成时使用的历史描述。')

    await userEvent.click(within(records).getByRole('button', { name: action }))

    expect(screen.queryByRole('complementary', { name: '生成记录' })).not.toBeInTheDocument()
    expect(description).toBeVisible()
    expect(description.textContent).toBe(originalText)
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('sheet'))
    expect(files.writes).toEqual([])
  })

  it('生成设置里换模型、关音频后出片：请求体照上游形状取当前组内容，提交后记录里出现生成中', async () => {
    provide()
    const user = userEvent.setup()
    const [firstShot] = document.shots
    if (firstShot === undefined) throw new Error('测试文档缺第一组')
    const posted: unknown[] = []
    let items = jobs
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items })),
      http.post('*/api/generations/video', async ({ request }) => {
        posted.push(await request.json())
        items = [runningJob, ...jobs]
        return HttpResponse.json({ task_id: runningJob.id }, { status: 202 })
      }),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    await user.click(
      await screen.findByRole('button', { name: '生成设置：moyu-seedance-2-5，音频开启' }),
    )
    const settings = await screen.findByRole('dialog', { name: '生成设置' })
    await user.click(within(settings).getByRole('radio', { name: 'wan3.0-video' }))
    await user.click(within(settings).getByRole('switch', { name: '生成音频' }))
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '生成设置' })).not.toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: '生成视频' }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted).toEqual([
      {
        aspect_ratio: '9:16',
        conversation_id: CONVERSATION_ID,
        generate_audio: false,
        model: 'wan3.0-video',
        reference_image_urls: firstShot.image_urls,
        seconds: firstShot.seconds,
        shot: firstShot.prompt,
        shot_index: 1,
      },
    ])
    expect(await screen.findByText('生成中 1')).toBeVisible()
    expect(screen.getByRole('button', { name: '生成设置：wan3.0-video，音频关闭' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '生成记录' }))
    const records = await screen.findByRole('complementary', { name: '生成记录' })
    expect(await within(records).findByText('生成中…')).toBeVisible()
  })

  it('服务端拒收出片时提示原话，不刷新记录', async () => {
    provide()
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return HttpResponse.json({ items: jobs })
      }),
      http.post('*/api/generations/video', () =>
        HttpResponse.json({ detail: '视频生成仅支持模型 moyu-seedance-2-5' }, { status: 422 }),
      ),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const generate = screen.getByRole('button', { name: '生成视频' })
    await waitFor(() => expect(generate).toBeEnabled())
    const readsBefore = reads

    await userEvent.click(generate)

    expect(await screen.findByText(/视频生成仅支持模型 moyu-seedance-2-5/)).toBeVisible()
    expect(reads).toBe(readsBefore)
    await waitFor(() => expect(generate).toBeEnabled())
  })

  it('视频模型清单读不到时说明原因，不能出片', async () => {
    provide()
    server.use(
      http.get('*/api/generations/video-models', () =>
        HttpResponse.json({ detail: '配置没加载' }, { status: 503 }),
      ),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    expect(
      await screen.findByRole('button', { name: '生成设置：视频模型读不到，音频开启' }),
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled()
  })

  it('刷新文件后保留所选镜头，失效的图片选择使用该镜头当前引用', async () => {
    provide()
    const { queryClient, router } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(navigationOf(page)).getByRole('button', { name: '镜头 2' }))
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toBeVisible()
    const latest: ShotsDocument = {
      ...document,
      shots: document.shots.map((shot) =>
        shot.index === 1
          ? {
              ...shot,
              image_urls: shot.image_urls.map((url, index) =>
                index === 1 ? 'https://example.com/new.png' : url,
              ),
              prompt: {
                ...shot.prompt,
                timeline: shot.prompt.timeline.map((item, index) =>
                  index === 1
                    ? { ...item, prompt: '第二镜改用第一张图 @Image1。', image_indexes: [1] }
                    : item,
                ),
              },
            }
          : shot,
      ),
    }
    provide(latest, 2)
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(CONVERSATION_ID, PATH),
      })
    })
    expect(await within(page).findByRole('textbox', { name: '镜头 2 的描述' })).toBeVisible()
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
      'src',
      'https://example.com/one.png',
    )
    expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2', frame: 2 })
  })

  it('小数时间段的胶片条显示 5.9 秒，不暴露浮点计算尾差', async () => {
    const fractional: ShotsDocument = {
      ...document,
      shots: document.shots
        .filter((shot) => shot.index === 1)
        .map((shot) => ({
          ...shot,
          seconds: 22,
          prompt: {
            ...shot.prompt,
            timeline: [
              { timestamps: [0, 16], prompt: '开场 @Image1。', image_indexes: [1] },
              { timestamps: [16, 21.9], prompt: '收尾 @Image2。', image_indexes: [2] },
            ],
          },
        })),
    }
    provide(fractional)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const scene = within(navigationOf(page)).getByRole('group', { name: '镜头 2' })
    expect(within(scene).getByText('5.9s')).toBeVisible()
  })

  it('文件内容无效时明确显示读取错误', async () => {
    provide('{ invalid JSON')
    await renderReader()
    expect(await screen.findByText('文件格式不对，读不出镜头组')).toBeVisible()
    expect(screen.queryByRole('region', { name: /镜头组 \d/ })).not.toBeInTheDocument()
  })

  it('编辑当前镜头更新派生引用，删除全部引用后仍可编辑、撤销，其他字段保持原值', async () => {
    const files = provide()
    await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(navigationOf(page)).getByRole('button', { name: '镜头 2' }))
    const editor = within(page).getByRole('textbox', { name: '镜头 2 的描述' })
    await replaceText(editor, '新的无图正文。')
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '新的无图正文。',
    )
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    const saved = files.snapshot()
    expect(saved.shots[0]?.prompt.timeline[1]).toEqual({
      timestamps: [3.25, 5],
      prompt: '新的无图正文。',
      image_indexes: [],
    })
    expect(saved.shots[0]?.prompt.global_settings).toBe(document.shots[0]?.prompt.global_settings)
    expect(saved.shots[0]?.prompt.timeline[0]).toEqual(document.shots[0]?.prompt.timeline[0])
    expect(saved.shots[0]?.image_urls).toEqual(document.shots[0]?.image_urls)
    expect(saved.shots[1]).toEqual(document.shots[1])
    editor.focus()
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '共用同一帧继续动作',
    )
  })

  it('非法引用保留在当前编辑器供修正，不保存、不跳镜也不创建无效图片', async () => {
    const files = provide(emptyDocument)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const editor = within(page).getByRole('textbox', { name: '镜头 1 的描述' })
    await replaceText(editor, '暂时输入 @Image9。')
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '本组没有图片',
    )
    expect(files.writes).toEqual([])
    expect(editor).toHaveTextContent('暂时输入 @9。')
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    expect(
      within(page).getByRole('button', { name: '看第 9 帧' }).querySelector('img'),
    ).not.toHaveAttribute('src')
    await replaceText(editor, '已修正的正文。')
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    expect(files.snapshot().shots[0]?.prompt.timeline[0]?.prompt).toBe('已修正的正文。')
  })

  it('完整面板编辑全局设定并保存，复制从原始字段读取最新正文与标记', async () => {
    const user = userEvent.setup()
    const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const files = provide()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await user.click(within(page).getByRole('button', { name: '复制镜头正文' }))
    expect(copied).toHaveBeenLastCalledWith(document.shots[0]?.prompt.timeline[0]?.prompt)
    await user.click(within(page).getByRole('button', { name: '完整提示词' }))
    const sheet = await screen.findByRole('complementary', { name: '镜头组完整提示词' })
    const settings = '  新设定 @Image01。\n\n保留换行。  '
    await replaceText(within(sheet).getByRole('textbox', { name: '全局设定' }), settings)
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    expect(files.snapshot().shots[0]?.prompt.global_settings).toBe(settings)
    expect(files.snapshot().shots[0]?.prompt.timeline).toEqual(document.shots[0]?.prompt.timeline)
    await user.click(within(sheet).getByRole('button', { name: '复制完整提示词' }))
    expect(copied).toHaveBeenLastCalledWith(
      settings +
        '\n\n[0–2.5秒｜镜头1]   模特走出门厅 @Image2，再看向鞋面 @Image1。\n' +
        '\n[3.25–5秒｜镜头2] 共用同一帧继续动作 @Image2，再次看向 @Image1。\n' +
        '[5–6秒｜镜头3] 这里保留旁白，没有图片引用。\n' +
        '不要生成字幕，不要生成背景音乐。',
    )
  })

  it('关联本组已有图片只插入引用，不追加地址，编号顺序由正文重新计算', async () => {
    const files = provide()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
    const picker = await screen.findByRole('dialog', { name: '添加图片' })
    await userEvent.click(within(picker).getByRole('button', { name: '关联第 3 张图片' }))
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    const saved = files.snapshot().shots[0]
    expect(saved?.image_urls).toEqual(document.shots[0]?.image_urls)
    expect(saved?.prompt.timeline[0]).toEqual({
      timestamps: [0, 2.5],
      prompt: document.shots[0]?.prompt.timeline[0]?.prompt + '@Image3',
      image_indexes: [2, 1, 3],
    })
    expect(within(page).getByRole('img', { name: '镜头组 1 第 3 帧' })).toHaveAttribute(
      'src',
      'https://example.com/unassigned.png',
    )
  })

  it('无图镜头首次上传期间仍能编辑，完成后在最新选区插入新编号并一起保存', async () => {
    const files = provide(emptyDocument)
    const release = delayedUpload()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
    await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
    expect(await within(page).findByRole('status')).toHaveTextContent('正在上传新图')
    const editor = within(page).getByRole('textbox', { name: '镜头 1 的描述' })
    await replaceText(editor, '上传时更新的正文。')
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    await act(async () => {
      release()
    })
    await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(1), {
      timeout: 3000,
    })
    const saved = files.snapshot().shots[0]
    expect(saved?.prompt.timeline[0]).toEqual({
      timestamps: [0, 3],
      prompt: '上传时更新的正文。@Image1',
      image_indexes: [1],
    })
    expect(saved?.prompt.timeline[1]).toEqual(emptyDocument.shots[0]?.prompt.timeline[1])
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
      'src',
      saved?.image_urls[0],
    )
  })

  it.each(['镜头', '镜头组', '图片'])(
    '新增上传期间切换%s 后，迟到结果不回填也不保存',
    async (target) => {
      const files = provide()
      const release = delayedUpload()
      let registered = 0
      server.events.on('response:mocked', ({ request }) => {
        if (request.method === 'POST' && request.url.includes('/api/assets/')) registered += 1
      })
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
      await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
      await within(page).findByRole('status')
      if (target === '镜头组')
        await userEvent.click(screen.getByRole('button', { name: '第 2 组' }))
      else if (target === '镜头')
        await userEvent.click(within(navigationOf(page)).getByRole('button', { name: '镜头 2' }))
      else await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
      await act(async () => {
        release()
      })
      await waitFor(() => expect(registered).toBe(1))
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(files.writes).toEqual([])
      expect(files.snapshot()).toEqual(document)
    },
  )

  it('替换共享编号只改该地址，保存失败保留新图草稿，重试不重新上传', async () => {
    const files = provide()
    files.failSave('服务暂时不可用')
    let uploads = 0
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.includes('/uploads/sign')) uploads += 1
    })
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    const retry = await screen.findByRole('button', { name: '重试保存' }, { timeout: 3000 })
    expect(screen.getByText('已上传，分镜未保存')).toBeVisible()
    const replacement = within(page)
      .getByRole('img', { name: '镜头组 1 第 2 帧' })
      .getAttribute('src')
    expect(replacement).toContain('/mock-oss/')
    expect(files.snapshot()).toEqual(document)
    files.failSave(undefined)
    await userEvent.click(retry)
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    expect(uploads).toBe(1)
    expect(files.snapshot().shots[0]?.image_urls).toEqual([
      'https://example.com/one.png',
      replacement,
      'https://example.com/unassigned.png',
    ])
    expect(files.snapshot().shots[0]?.prompt).toEqual(document.shots[0]?.prompt)
    await userEvent.click(within(navigationOf(page)).getByRole('button', { name: '镜头 2' }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      replacement,
    )
    files.failSave('后续正文暂时无法保存')
    const editor = within(page).getByRole('textbox', { name: '镜头 2 的描述' })
    editor.focus()
    pasteTextIntoComposer(editor, '后续文字。')
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '没存下',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it('共享提示按本组编号统计，不把相同 URL 的另一编号算进来', async () => {
    const shared: ShotsDocument = {
      ...document,
      shots: document.shots.map((shot) =>
        shot.index === 1
          ? {
              ...shot,
              image_urls: [
                'https://example.com/one.png',
                'https://example.com/two.png',
                'https://example.com/two.png',
              ],
              prompt: {
                ...shot.prompt,
                timeline: shot.prompt.timeline.map((item, index) =>
                  index === 2
                    ? { ...item, prompt: '第三镜只用另一编号 @Image3。', image_indexes: [3] }
                    : item,
                ),
              },
            }
          : shot,
      ),
    }
    provide(shared)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).getByText('@Image2 · 镜头 1、镜头 2 共用')).toBeVisible()
    expect(within(page).queryByText(/镜头 1、2、3 共用/)).not.toBeInTheDocument()
  })

  it('无图镜头的完整面板提供明确参考图空态', async () => {
    provide(emptyDocument)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '完整提示词' }))
    const sheet = await screen.findByRole('complementary', { name: '镜头组完整提示词' })
    const references = within(sheet).getByRole('region', { name: '本组参考图' })
    expect(within(references).getByText('本组暂无参考图')).toBeVisible()
    expect(within(references).queryByRole('img')).not.toBeInTheDocument()
  })

  it('关联已有图片保存失败不会误报为上传成功', async () => {
    const files = provide()
    files.failSave('保存失败')
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
    await userEvent.click(screen.getByRole('button', { name: '关联第 3 张图片' }))
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '没存下',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it.each(['新增', '替换'])('%s上传失败保留原文件和图片，不安排分镜保存', async (mode) => {
    const files = provide()
    server.use(http.put('*/mock-oss/:assetId', () => new HttpResponse(null, { status: 503 })))
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    if (mode === '新增') {
      await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
      await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
    } else await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    expect(await screen.findByText('上传失败：503')).toBeVisible()
    expect(files.writes).toEqual([])
    expect(files.snapshot()).toEqual(document)
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'https://example.com/two.png',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it('替换上传期间服务器换掉目标地址，迟到上传不覆盖服务器新图', async () => {
    const files = provide()
    const release = delayedUpload()
    let registered = 0
    server.events.on('response:mocked', ({ request }) => {
      if (request.method === 'POST' && request.url.includes('/api/assets/')) registered += 1
    })
    const { queryClient } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    await within(page).findByRole('status')
    const latest: ShotsDocument = {
      ...document,
      shots: document.shots.map((shot) =>
        shot.index === 1
          ? {
              ...shot,
              image_urls: shot.image_urls.map((url, index) =>
                index === 1 ? 'https://example.com/server.png' : url,
              ),
            }
          : shot,
      ),
    }
    const remote = provide(latest, 2)
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(CONVERSATION_ID, PATH),
      })
    })
    await waitFor(() =>
      expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
        'src',
        'https://example.com/server.png',
      ),
    )
    await act(async () => {
      release()
    })
    await waitFor(() => expect(registered).toBe(1))
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
    expect(files.writes).toEqual([])
    expect(remote.writes).toEqual([])
    expect(remote.snapshot()).toEqual(latest)
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'https://example.com/server.png',
    )
  })
})
