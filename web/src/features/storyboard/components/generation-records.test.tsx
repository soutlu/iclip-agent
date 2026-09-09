import { render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Toaster, toast } from '@/shared/ui/toast'
import { server } from '@/testing/mocks/server'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationJob } from '../storyboard.api'
import { GenerationRecords } from './generation-records'

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob => ({
  createdAt: '2026-09-01T10:00:00Z',
  errorMessage: null,
  kind: 'video',
  outputUrl: null,
  request: {},
  shotIndex: 2,
  status: 'completed',
  taskId: null,
  watermarkOutputUrl: null,
  ...spec,
})

const jobs: GenerationJob[] = [
  job({
    createdAt: new Date(2026, 8, 1, 10, 4).toISOString(),
    id: 'a',
    outputUrl: 'take-1.mp4',
    request: { prompt: '第一版：走向镜头。' },
  }),
  job({
    createdAt: new Date(2026, 8, 1, 11, 40).toISOString(),
    errorMessage: '上游返回了空结果。',
    id: 'b',
    request: { prompt: '第二版：加一个低头动作。' },
    status: 'failed',
  }),
  job({
    createdAt: new Date(2026, 8, 1, 12, 20).toISOString(),
    id: 'c',
    request: { prompt: '第三版：脚步放慢。' },
    status: 'submitted',
  }),
  job({ id: 'other-shot', request: { prompt: '别的组。' }, shotIndex: 3 }),
  job({
    createdAt: new Date(2026, 8, 1, 9, 30).toISOString(),
    id: 'img',
    kind: 'image',
    outputUrl: 'frame.png',
    request: { prompt: '出镜头帧：门厅全景。' },
    shotIndex: null,
  }),
]

const renderRecords = (onClose = vi.fn()) => {
  render(<GenerationRecords jobs={jobs} onClose={onClose} onEditPrompt={vi.fn()} shotIndex={2} />)
  return onClose
}

beforeEach(() => {
  // 下载菜单是 Radix 弹层，定位时要量尺寸；jsdom 没有 ResizeObserver。
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

describe('GenerationRecords', () => {
  it('只列本组视频，排除图片和其它组，按时间倒序', () => {
    renderRecords()

    expect(screen.getByRole('heading', { name: '当前镜头组 · 视频' })).toBeVisible()
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByText('别的组。')).not.toBeInTheDocument()
    expect(screen.queryByText('出镜头帧：门厅全景。')).not.toBeInTheDocument()

    const prompts = screen.getAllByText(/第[一二三]版/).map((node) => node.textContent)
    expect(prompts).toEqual([
      '第三版：脚步放慢。',
      '第二版：加一个低头动作。',
      '第一版：走向镜头。',
    ])
  })

  it('三种状态各写清楚，失败的把服务端原话摆出来', () => {
    renderRecords()

    expect(screen.getByText('生成中…')).toBeVisible()
    expect(screen.getByText('生成完成')).toBeVisible()
    expect(screen.getByText('生成失败')).toBeVisible()
    expect(screen.getByText('上游返回了空结果。')).toBeVisible()
  })

  it('只有完成且有结果的记录提供下载，折叠后仍可下载', async () => {
    renderRecords()
    expect(screen.getAllByRole('button', { name: '下载视频' })).toHaveLength(1)
    const card = screen.getByText('第一版：走向镜头。').closest('article') as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: '收起这条记录' }))
    expect(within(card).getByRole('button', { name: '下载视频' })).toBeEnabled()
  })

  it.each(['http', 'network', 'empty'])(
    '下载遇到 %s 错误时提示失败并允许重试，等待时阻止重复点击',
    async (failure) => {
      let requests = 0
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const url = 'https://downloads.example.test/result.webm'
      server.use(
        http.get(url, async () => {
          requests += 1
          await gate
          if (failure === 'network') return HttpResponse.error()
          return new HttpResponse(null, { status: failure === 'http' ? 503 : 200 })
        }),
      )
      const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      render(
        <>
          <Toaster />
          <GenerationRecords
            jobs={[job({ id: 'download', outputUrl: url })]}
            onClose={vi.fn()}
            onEditPrompt={vi.fn()}
            shotIndex={2}
          />
        </>,
      )
      await userEvent.click(screen.getByRole('button', { name: '下载视频' }))
      const busy = screen.getByRole('button', { name: '正在准备下载…' })
      expect(busy).toBeDisabled()
      await userEvent.click(busy)
      await waitFor(() => expect(requests).toBe(1))
      release()
      expect(await screen.findByText('视频下载失败，请重试')).toBeVisible()
      expect(screen.getByRole('button', { name: '下载视频' })).toBeEnabled()
      expect(anchorClick).not.toHaveBeenCalled()
      await userEvent.click(screen.getByRole('button', { name: '下载视频' }))
      await waitFor(() => expect(requests).toBe(2))
      await waitFor(() => expect(screen.getByRole('button', { name: '下载视频' })).toBeEnabled())
    },
  )

  it('上游给了水印版时，下载先选原片或水印版，各取各的地址', async () => {
    const user = userEvent.setup()
    const requested: string[] = []
    server.use(
      http.get('https://downloads.example.test/*', ({ request }) => {
        requested.push(request.url)
        return new HttpResponse(null, { status: 503 })
      }),
    )
    render(
      <>
        <Toaster />
        <GenerationRecords
          jobs={[
            job({
              id: 'marked',
              outputUrl: 'https://downloads.example.test/clean.mp4',
              watermarkOutputUrl: 'https://downloads.example.test/marked.mp4',
            }),
          ]}
          onClose={vi.fn()}
          onEditPrompt={vi.fn()}
          shotIndex={2}
        />
      </>,
    )
    await user.click(screen.getByRole('button', { name: '下载视频' }))
    await user.click(await screen.findByRole('menuitem', { name: '下载水印版' }))
    await waitFor(() => expect(requested).toEqual(['https://downloads.example.test/marked.mp4']))
    expect(await screen.findByText('视频下载失败，请重试')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: '下载视频' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: '下载视频' }))
    await user.click(await screen.findByRole('menuitem', { name: '下载原片' }))
    await waitFor(() => expect(requested).toHaveLength(2))
    expect(requested[1]).toBe('https://downloads.example.test/clean.mp4')
  })

  it('时刻写成年月日时分', () => {
    renderRecords()
    expect(screen.getByText('2026-09-01 12:20')).toBeVisible()
  })

  it('折叠箭头收起之后隐藏运行中的描述', async () => {
    renderRecords()
    const card = screen.getByText('第三版：脚步放慢。').closest('article') as HTMLElement

    await userEvent.click(within(card).getByRole('button', { name: '收起这条记录' }))

    expect(within(card).queryByText('第三版：脚步放慢。')).not.toBeInTheDocument()
    expect(within(card).getByText('生成中…')).toBeVisible()
  })

  it('编辑生成交出记录里的镜头组，起止秒与正文空白原样保留', async () => {
    const onEditPrompt = vi.fn()
    render(
      <GenerationRecords
        jobs={[
          job({
            id: 'structured',
            request: {
              prompt: '拼好的正文',
              shot: {
                global_settings: '  产品：黑色短靴。\n剪辑形式：硬切。',
                timeline: [
                  { image_indexes: [1], prompt: '走近 @Image1。\n', timestamps: [0, 2] },
                  { image_indexes: [2], prompt: '停下 @Image2。', timestamps: [2, 6] },
                ],
              },
            },
          }),
        ]}
        onClose={vi.fn()}
        onEditPrompt={onEditPrompt}
        shotIndex={2}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: '编辑生成' }))

    expect(onEditPrompt).toHaveBeenCalledExactlyOnceWith({
      global_settings: '  产品：黑色短靴。\n剪辑形式：硬切。',
      timeline: [
        { timestamps: [0, 2], prompt: '走近 @Image1。\n', image_indexes: [1] },
        { timestamps: [2, 6], prompt: '停下 @Image2。', image_indexes: [2] },
      ],
    })
  })

  it.each([
    ['没有 shot', { prompt: '模特走向镜头，停下微笑。' }],
    ['shot 为空', { prompt: '正文', shot: null }],
    ['shot 缺时间线', { prompt: '正文', shot: { global_settings: '设定。', timeline: [] } }],
    ['正文也没有', {}],
  ])('记录%s时禁用编辑生成', async (_name, request) => {
    const onEditPrompt = vi.fn()
    render(
      <GenerationRecords
        jobs={[job({ id: 'no-shot', request })]}
        onClose={vi.fn()}
        onEditPrompt={onEditPrompt}
        shotIndex={2}
      />,
    )

    const edit = screen.getByRole('button', { name: '编辑生成' })
    expect(edit).toBeDisabled()
    await userEvent.click(edit)
    expect(onEditPrompt).not.toHaveBeenCalled()
  })

  it('收起已完成记录隐藏描述与编辑按钮，视频预览和播放入口仍保留', async () => {
    renderRecords()
    const card = screen.getByText('第一版：走向镜头。').closest('article') as HTMLElement

    await userEvent.click(within(card).getByRole('button', { name: '收起这条记录' }))

    expect(within(card).queryByText('视频描述')).not.toBeInTheDocument()
    expect(within(card).queryByText('第一版：走向镜头。')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '编辑生成' })).not.toBeInTheDocument()
    const play = within(card).getByRole('button', { name: '播放视频' })
    expect(play).toBeVisible()
    expect(document.querySelector('video')).toBeNull()

    await userEvent.click(play)
    const dialog = await screen.findByRole('dialog', { name: '生成的视频' })
    expect(within(dialog).getByLabelText('生成的视频')).toHaveAttribute('src', 'take-1.mp4')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '生成的视频' })).not.toBeInTheDocument()
    expect(document.querySelector('video')).toBeNull()
    await waitFor(() => expect(play).toHaveFocus())

    await userEvent.click(within(card).getByRole('button', { name: '展开这条记录' }))
    expect(within(card).getByText('第一版：走向镜头。')).toBeVisible()
    expect(within(card).getByRole('button', { name: '编辑生成' })).toBeInTheDocument()
  })

  it.each([
    {
      name: 'OSS封面',
      url: 'https://assets.oss-cn-shanghai.aliyuncs.com/take.mp4',
      hasPoster: true,
    },
    { name: '非OSS视频图标', url: 'https://example.com/take.mp4', hasPoster: false },
  ])(
    '$name 默认不挂载视频，点击后在共享预览中播放正确地址，关闭后卸载并归还焦点',
    async ({ url, hasPoster }) => {
      const { container } = render(
        <GenerationRecords
          jobs={[job({ id: 'preview', outputUrl: url })]}
          onClose={vi.fn()}
          onEditPrompt={vi.fn()}
          shotIndex={2}
        />,
      )
      const play = screen.getByRole('button', { name: '播放视频' })
      expect(document.querySelector('video')).toBeNull()
      const poster = play.querySelector('img')
      if (hasPoster) {
        expect(poster).toHaveAttribute(
          'src',
          expect.stringContaining(`${url}?x-oss-process=video/snapshot,`),
        )
      } else {
        expect(poster).toBeNull()
      }

      await userEvent.click(play)

      const dialog = await screen.findByRole('dialog', { name: '生成的视频' })
      expect(container).not.toContainElement(dialog)
      const video = within(dialog).getByLabelText('生成的视频')
      expect(video.tagName).toBe('VIDEO')
      expect(video).toHaveAttribute('src', url)
      expect(video).toHaveAttribute('controls')
      expect(video).toHaveAttribute('autoplay')
      expect(document.querySelectorAll('video')).toHaveLength(1)

      await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

      expect(screen.queryByRole('dialog', { name: '生成的视频' })).not.toBeInTheDocument()
      expect(document.querySelector('video')).toBeNull()
      await waitFor(() => expect(play).toHaveFocus())
    },
  )

  it('只有图片或其它组的视频时，当前组仍显示空态', () => {
    render(
      <GenerationRecords
        jobs={jobs.filter((item) => item.kind === 'image' || item.shotIndex === 3)}
        onClose={vi.fn()}
        onEditPrompt={vi.fn()}
        shotIndex={2}
      />,
    )
    expect(screen.getByText('暂无视频记录')).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('空态可返回分镜，关闭抽屉且不回填提示词', async () => {
    const onClose = vi.fn()
    const onEditPrompt = vi.fn()
    render(
      <GenerationRecords jobs={[]} onClose={onClose} onEditPrompt={onEditPrompt} shotIndex={2} />,
    )
    expect(screen.getByText('暂无视频记录')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '返回分镜' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onEditPrompt).not.toHaveBeenCalled()
  })

  it('✕ 关掉抽屉', async () => {
    const onClose = renderRecords()
    await userEvent.click(screen.getByRole('button', { name: '关闭生成记录' }))
    expect(onClose).toHaveBeenCalled()
  })
})
