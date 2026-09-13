import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/shared/ui/toast'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { pasteTextIntoComposer } from '@/testing/editor'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ShotsDocument } from '../shot-document'
import { StoryboardReader } from './storyboard-reader'

const PATH = 'video_shot.json'
const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
const deferred = () => {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${PATH}`,
  source: { kind: 'file', path: PATH, version: 1 },
  title: '完全复刻',
  type: 'storyboard',
}
const fixture: ShotsDocument = {
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      seconds: 8,
      image_urls: ['https://example.com/person.png', 'https://example.com/product.png'],
      prompt: {
        global_settings: '人物参照 @Image1。产品参照 @Image2。',
        timeline: [
          { timestamps: [0, 4], prompt: '展示者拿起产品。', image_indexes: [] },
          { timestamps: [4, 8], prompt: '展示者展示产品侧面。', image_indexes: [] },
        ],
      },
    },
  ],
}

const provide = (document = fixture) => {
  let stored = structuredClone(document)
  let version = 1
  let saveError = false
  let saveDelay: Promise<void> | undefined
  const writes: { content: string; path: string }[] = []
  const submissions: unknown[] = []
  const events: string[] = []
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/file', ({ request }) => {
      if (new URL(request.url).searchParams.get('path') !== PATH)
        return HttpResponse.json({ detail: '文件不存在' }, { status: 404 })
      return HttpResponse.json({ file: { path: PATH, content: JSON.stringify(stored), version } })
    }),
    http.put('*/api/conversations/:conversationId/workspace/file', async ({ request }) => {
      const body = (await request.json()) as {
        content: string
        path: string
        expectedVersion: number
      }
      writes.push(body)
      await saveDelay
      if (saveError) return HttpResponse.json({ detail: '写入暂时不可用' }, { status: 503 })
      if (body.expectedVersion !== version)
        return HttpResponse.json({ detail: '版本冲突' }, { status: 409 })
      stored = JSON.parse(body.content) as ShotsDocument
      version += 1
      events.push('save')
      return HttpResponse.json({ file: { path: PATH, content: body.content, version } })
    }),
    http.get('*/api/generations', () => HttpResponse.json({ items: [] })),
    http.get('*/api/generations/video-models', () =>
      HttpResponse.json({ items: ['seedance_2.0'], default: 'seedance_2.0' }),
    ),
    http.post('*/api/generations/video', async ({ request }) => {
      submissions.push(await request.json())
      events.push('generate')
      return HttpResponse.json({ task_id: 'a1b2c3d4', status: 'submitted' }, { status: 202 })
    }),
  )
  return {
    writes,
    submissions,
    events,
    delaySave: (delay: Promise<void>) => {
      saveDelay = delay
    },
    removeLastScene: () => {
      stored.shots = stored.shots.map((shot) => ({
        ...shot,
        prompt: { ...shot.prompt, timeline: shot.prompt.timeline.slice(0, -1) },
      }))
      version += 1
    },
    stored: () => stored,
    failSave: () => {
      saveError = true
    },
    changeAspect: () => {
      stored.aspect_ratio = '16:9'
      version += 1
    },
    changeRemote: () => {
      stored.shots = stored.shots.map((shot) => ({
        ...shot,
        prompt: { ...shot.prompt, global_settings: '远端改动 @Image1。' },
      }))
      version += 1
    },
  }
}
const renderReader = () =>
  renderWithProviders(
    <>
      <StoryboardReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={false} />
      <Toaster />
    </>,
    { initialPath: '/?shot=1' },
  )
const replaceText = async (editor: HTMLElement, text: string) => {
  editor.focus()
  await userEvent.keyboard('{Control>}a{/Control}')
  pasteTextIntoComposer(editor, text)
}

describe('StoryboardReader 全局设定与参考图', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('全局图片原位展开，切图不修改引用，切到无图镜头后收起', async () => {
    const state = provide()
    await renderReader()
    const nav = await screen.findByRole('navigation', { name: '本组镜头' })
    const global = within(nav).getByRole('group', { name: '全局设定' })
    expect(within(global).getAllByRole('button')).toHaveLength(2)
    await userEvent.click(within(global).getByRole('button', { name: '预览第 2 帧' }))
    expect(await screen.findByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      fixture.shots[0]?.image_urls[1],
    )
    expect(screen.getByRole('textbox', { name: '全局设定' })).toBeVisible()
    expect(state.writes).toEqual([])
    await userEvent.click(within(nav).getByRole('button', { name: '镜头 1' }))
    expect(within(nav).getByRole('button', { name: '镜头 1' })).toHaveFocus()
    expect(within(global).getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '镜头 1 的描述' })).toHaveTextContent(
      '展示者拿起产品。',
    )
    expect(screen.queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    expect(state.writes).toEqual([])
  })
  it('编辑全局设定与镜头正文后先保存再提交同一内容', async () => {
    const state = provide()
    await renderReader()
    await replaceText(
      await screen.findByRole('textbox', { name: '全局设定' }),
      '新设定 @Image1 与 @Image2。',
    )
    await userEvent.click(screen.getByRole('button', { name: '镜头 2' }))
    await replaceText(screen.getByRole('textbox', { name: '镜头 2 的描述' }), '展示者转动产品。')
    await userEvent.click(screen.getByRole('button', { name: '生成视频' }))
    await waitFor(() => expect(state.submissions).toHaveLength(1))
    expect(state.events.at(-1)).toBe('generate')
    expect(state.events.slice(0, -1)).toContain('save')
    expect(state.writes[0]?.path).toBe(PATH)
    expect(state.stored().shots[0]?.prompt.timeline.map((item) => item.image_indexes)).toEqual([
      [],
      [],
    ])
    expect(state.submissions[0]).toMatchObject({
      shot: state.stored().shots[0]?.prompt,
      reference_image_urls: fixture.shots[0]?.image_urls,
      metadata: { path: PATH, shot: 1 },
    })
  })
  it('保存合并远端画幅变化后生成使用已落盘的新画幅', async () => {
    const state = provide()
    await renderReader()
    await userEvent.click(await screen.findByRole('button', { name: '镜头 1' }))
    await replaceText(await screen.findByRole('textbox', { name: '镜头 1 的描述' }), '新动作。')
    state.changeAspect()
    await userEvent.click(screen.getByRole('button', { name: '生成视频' }))
    await waitFor(() => expect(state.submissions).toHaveLength(1))
    expect(state.stored().aspect_ratio).toBe('16:9')
    expect(state.submissions[0]).toMatchObject({
      aspect_ratio: '16:9',
      shot: state.stored().shots[0]?.prompt,
    })
  })

  it('保存失败保留草稿并阻止生成', async () => {
    const state = provide()
    state.failSave()
    await renderReader()
    await userEvent.click(await screen.findByRole('button', { name: '镜头 1' }))
    await replaceText(
      await screen.findByRole('textbox', { name: '镜头 1 的描述' }),
      '未保存的动作。',
    )
    await userEvent.click(screen.getByRole('button', { name: '生成视频' }))
    expect(await screen.findByRole('button', { name: '重试保存' })).toBeInTheDocument()
    expect(state.submissions).toEqual([])
    expect(screen.getByRole('textbox', { name: '镜头 1 的描述' })).toHaveTextContent(
      '未保存的动作。',
    )
  })
  it('远端同组变化时处理冲突后才继续保存', async () => {
    const state = provide()
    await renderReader()
    await userEvent.click(await screen.findByRole('button', { name: '镜头 1' }))
    await replaceText(await screen.findByRole('textbox', { name: '镜头 1 的描述' }), '本地动作。')
    state.changeRemote()
    await userEvent.click(screen.getByRole('button', { name: '生成视频' }))
    const dialog = await screen.findByRole('dialog', { name: '这一组有别的改动' })
    expect(state.submissions).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: '留我的' }))
    await waitFor(() =>
      expect(state.stored().shots[0]?.prompt.timeline[0]?.prompt).toBe('本地动作。'),
    )
  })
  it('添加图片只追加全局引用，替换保持编号和时间线', async () => {
    const state = provide()
    await renderReader()
    await screen.findByRole('navigation', { name: '本组镜头' })
    await userEvent.click(screen.getByRole('button', { name: '添加图片' }))
    await userEvent.upload(
      screen.getByLabelText('选择要上传的图片'),
      new File(['new'], 'new.png', { type: 'image/png' }),
    )
    await waitFor(() => expect(state.stored().shots[0]?.image_urls).toHaveLength(3))
    expect(state.stored().shots[0]?.prompt.global_settings).toContain('@Image3')
    expect(state.stored().shots[0]?.prompt.timeline).toEqual(fixture.shots[0]?.prompt.timeline)
    await userEvent.click(
      within(screen.getByRole('navigation', { name: '本组镜头' })).getByRole('button', {
        name: '预览第 2 帧',
      }),
    )
    await userEvent.upload(
      screen.getByLabelText('选择替换图片'),
      new File(['replacement'], 'replacement.png', { type: 'image/png' }),
    )
    await waitFor(() =>
      expect(state.stored().shots[0]?.image_urls[1]).not.toBe(fixture.shots[0]?.image_urls[1]),
    )
    expect(state.stored().shots[0]?.image_urls).toHaveLength(3)
    expect(state.stored().shots[0]?.prompt.timeline).toEqual(fixture.shots[0]?.prompt.timeline)
  })
  it('全局设定无图时仍可编辑，添加首图只修改全局正文', async () => {
    const document = structuredClone(fixture)
    const shot = document.shots[0]
    if (shot === undefined) throw new Error('缺少镜头组')
    shot.image_urls = []
    shot.prompt.global_settings = '自然光，固定机位。'
    const state = provide(document)
    await renderReader()
    expect(await screen.findByRole('textbox', { name: '全局设定' })).toHaveTextContent(
      '自然光，固定机位。',
    )
    expect(screen.queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '添加图片' }))
    await userEvent.upload(
      screen.getByLabelText('选择要上传的图片'),
      new File(['image'], 'first.png', { type: 'image/png' }),
    )
    await waitFor(() => expect(state.stored().shots[0]?.image_urls).toHaveLength(1))
    expect(state.stored().shots[0]?.prompt.global_settings).toContain('@Image1')
    expect(state.stored().shots[0]?.prompt.timeline).toEqual(shot.prompt.timeline)
  })

  it('30 张全局参考图原位展开，共用图片不改变所选内容，上限不阻止引用已有图片', async () => {
    const document = structuredClone(fixture)
    const shot = document.shots[0]
    if (shot === undefined) throw new Error('缺少镜头组')
    shot.image_urls = Array.from({ length: 30 }, (_, i) => `https://example.com/${i + 1}.png`)
    shot.prompt.global_settings = shot.image_urls.map((_, i) => `参考 @Image${i + 1}。`).join('')
    shot.prompt.timeline[0] = {
      timestamps: [0, 4],
      prompt: '展示产品 @Image30。',
      image_indexes: [30],
    }
    const state = provide(document)
    await renderReader()
    const nav = await screen.findByRole('navigation', { name: '本组镜头' })
    const global = within(nav).getByRole('group', { name: '全局设定' })
    expect(within(global).getAllByRole('button')).toHaveLength(30)
    await userEvent.click(within(global).getByRole('button', { name: '预览第 30 帧' }))
    expect(screen.getByRole('textbox', { name: '全局设定' })).toBeVisible()
    expect(screen.getByRole('img', { name: '镜头组 1 第 30 帧' })).toHaveAttribute(
      'src',
      shot.image_urls[29],
    )
    expect(state.writes).toEqual([])
    await userEvent.click(within(nav).getByRole('button', { name: '镜头 1' }))
    expect(within(global).getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '镜头 1 的描述' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '添加图片' }))
    expect(screen.getByRole('button', { name: '上传图片' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '关联第 2 张图片' }))
    await waitFor(() =>
      expect(state.stored().shots[0]?.prompt.timeline[0]?.image_indexes).toEqual([30, 2]),
    )
    expect(state.stored().shots[0]?.image_urls).toHaveLength(30)
    expect(state.stored().shots[0]?.prompt.global_settings).toBe(shot.prompt.global_settings)
  })
  it('上传期间禁止生成，删除旧引用后新图仍写入当前全局设定', async () => {
    const state = provide()
    let release = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.put('*/mock-oss/:uploadId', async () => {
        await pending
        return new HttpResponse(null, { status: 200 })
      }),
    )
    await renderReader()
    const editor = await screen.findByRole('textbox', { name: '全局设定' })
    await userEvent.click(screen.getByRole('button', { name: '添加图片' }))
    await userEvent.upload(
      screen.getByLabelText('选择要上传的图片'),
      new File(['image'], 'new.png', { type: 'image/png' }),
    )
    expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled()
    await replaceText(editor, '新设定，保留自然光。')
    release()
    await waitFor(() => expect(state.stored().shots[0]?.image_urls).toHaveLength(3))
    expect(state.stored().shots[0]?.prompt.global_settings).toBe('新设定，保留自然光。@Image3')
    await userEvent.click(screen.getByRole('button', { name: '生成视频' }))
    await waitFor(() => expect(state.submissions).toHaveLength(1))
    expect(state.submissions[0]).toMatchObject({ shot: state.stored().shots[0]?.prompt })
  })
  it.each(['外部路由切换', '远端移除镜头'])(
    '上传期间%s 后恢复操作，迟到图片不回填',
    async (change) => {
      const state = provide()
      const upload = deferred()
      const registered = deferred()
      server.use(
        http.put('*/mock-oss/:uploadId', async () => {
          await upload.promise
          return new HttpResponse(null, { status: 200 })
        }),
      )
      const onResponse = ({ request }: { request: Request }) => {
        if (request.method === 'POST' && request.url.endsWith('/confirm')) registered.release()
      }
      server.events.on('response:mocked', onResponse)
      try {
        const { router, queryClient } = await renderReader()
        await userEvent.click(await screen.findByRole('button', { name: '镜头 2' }))
        await userEvent.click(screen.getByRole('button', { name: '添加图片' }))
        await userEvent.upload(
          screen.getByLabelText('选择要上传的图片'),
          new File(['late'], 'late.png', { type: 'image/png' }),
        )
        expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled()
        await act(async () => {
          if (change === '外部路由切换')
            await router.navigate({
              to: '/',
              search: (previous) => ({ ...previous, shot: 1, content: 'global' }),
            })
          else {
            state.removeLastScene()
            await queryClient.invalidateQueries()
          }
        })
        expect(await screen.findByRole('textbox', { name: '全局设定' })).toBeVisible()
        await waitFor(() => expect(screen.getByRole('button', { name: '添加图片' })).toBeEnabled())
        expect(screen.getByRole('button', { name: '生成视频' })).toBeEnabled()
        await act(async () => {
          upload.release()
          await registered.promise
        })
        // 等过自动保存窗口，确认旧请求没有产生迟到的草稿写入。
        await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
        expect(state.writes).toEqual([])
        expect(state.stored().shots[0]?.image_urls).toEqual(fixture.shots[0]?.image_urls)
        await userEvent.click(screen.getByRole('button', { name: '生成视频' }))
        await waitFor(() => expect(state.submissions).toHaveLength(1))
        expect(state.submissions[0]).toMatchObject({
          shot: state.stored().shots[0]?.prompt,
          reference_image_urls: fixture.shots[0]?.image_urls,
        })
      } finally {
        upload.release()
        server.events.removeListener('response:mocked', onResponse)
      }
    },
  )
  it('生成等待保存时不能新增或替换图片，保存后提交原参考图并恢复操作', async () => {
    const state = provide()
    const save = deferred()
    state.delaySave(save.promise)
    let uploads = 0
    const onRequest = ({ request }: { request: Request }) => {
      if (request.method === 'POST' && request.url.includes('/uploads/sign')) uploads += 1
    }
    server.events.on('request:start', onRequest)
    try {
      await renderReader()
      await replaceText(
        await screen.findByRole('textbox', { name: '全局设定' }),
        '准备生成的设定 @Image1 与 @Image2。',
      )
      const replacementInput = screen.getByLabelText('选择替换图片')
      await userEvent.click(screen.getByRole('button', { name: '生成视频' }))
      await waitFor(() => expect(state.writes).toHaveLength(1))
      expect(state.submissions).toEqual([])
      const addImage = screen.getByRole('button', { name: '添加图片' })
      expect(addImage).toBeDisabled()
      expect(screen.getByRole('button', { name: '替换图片' })).toBeDisabled()
      await userEvent.click(addImage)
      expect(screen.queryByRole('dialog', { name: '添加图片' })).not.toBeInTheDocument()
      // 模拟原生文件选择器迟到返回；即使 change 到达已禁用的 input，也不能启动上传。
      fireEvent.change(replacementInput, {
        target: { files: [new File(['late'], 'late.png', { type: 'image/png' })] },
      })
      await act(async () => {
        save.release()
      })
      await waitFor(() => expect(state.submissions).toHaveLength(1))
      expect(uploads).toBe(0)
      expect(state.submissions[0]).toMatchObject({
        shot: state.stored().shots[0]?.prompt,
        reference_image_urls: fixture.shots[0]?.image_urls,
      })
      expect(state.writes).toHaveLength(1)
      await waitFor(() => expect(screen.getByRole('button', { name: '添加图片' })).toBeEnabled())
      await userEvent.click(screen.getByRole('button', { name: '添加图片' }))
      expect(await screen.findByRole('dialog', { name: '添加图片' })).toBeVisible()
    } finally {
      save.release()
      server.events.removeListener('request:start', onRequest)
    }
  })
})
