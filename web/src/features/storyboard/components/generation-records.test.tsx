import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Toaster, toast } from '@/shared/ui/toast'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { GenerationRecords } from './generation-records'

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob =>
  makeGenerationJob({ createdAt: '2026-09-01T10:00:00Z', metadata: { shot: 2 }, ...spec })

/** 含这段文字的那张记录卡。 */
const cardWith = (text: string): HTMLElement => {
  const card = screen
    .getAllByRole('article')
    .find((item) => within(item).queryByText(text) !== null)
  if (card === undefined) throw new Error(`没有含「${text}」的记录卡`)
  return card
}

// 与接口一样新的在前。
const jobs: GenerationJob[] = [
  job({
    createdAt: new Date(2026, 8, 1, 12, 20).toISOString(),
    id: 'c',
    request: { prompt: '第三版：脚步放慢。', model: 'moyu-seedance-2-5' },
    status: 'submitted',
  }),
  job({
    createdAt: new Date(2026, 8, 1, 11, 40).toISOString(),
    errorMessage: '上游返回了空结果。',
    id: 'b',
    // 空白的模型名与缺失同样算没记。
    request: { prompt: '第二版：加一个低头动作。', model: '  ' },
    status: 'failed',
  }),
  job({
    createdAt: new Date(2026, 8, 1, 10, 4).toISOString(),
    id: 'a',
    outputUrl: 'take-1.mp4',
    request: { prompt: '第一版：走向镜头。', model: 'wan3.0-video' },
  }),
  job({
    id: 'other-shot',
    metadata: { shot: 3 },
    request: { prompt: '别的组。' },
  }),
  job({
    createdAt: new Date(2026, 8, 1, 9, 30).toISOString(),
    id: 'img',
    kind: 'image',
    outputUrl: 'frame.png',
    metadata: null,
    request: { prompt: '出镜头帧：门厅全景。' },
  }),
]

const renderRecords = async () => {
  return renderWithProviders(
    <GenerationRecords
      jobs={jobs}
      onClose={() => {}}
      onEditPrompt={() => {}}
      onEditVideo={() => {}}
      shotIndex={2}
    />,
  )
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
})

afterEach(() => {
  toast.dismiss()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GenerationRecords', () => {
  it('只列本组视频，排除图片和其它组，保持接口给的新旧顺序', async () => {
    await renderRecords()

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
    const cards = screen.getAllByRole('article')
    expect(cards.map((card) => within(card).getByText(/^模型 · /).textContent)).toEqual([
      '模型 · moyu-seedance-2-5',
      '模型 · 未记录',
      '模型 · wan3.0-video',
    ])
  })

  it('三种状态各写清楚，失败的把服务端原话摆出来', async () => {
    await renderRecords()

    expect(screen.getByText('生成中')).toBeVisible()
    expect(screen.getByText('已完成')).toBeVisible()
    expect(screen.getByText('生成失败')).toBeVisible()
    expect(screen.getByText('上游返回了空结果。')).toBeVisible()
  })

  it('只有完成且有结果的记录提供下载，折叠后仍可下载', async () => {
    await renderRecords()
    expect(screen.getAllByRole('button', { name: '下载视频' })).toHaveLength(1)
    const card = cardWith('第一版：走向镜头。')
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
          if (failure === 'http') return new HttpResponse('下载服务不可用', { status: 503 })
          return new HttpResponse(null, { status: 200 })
        }),
      )
      const createObjectURL = vi.fn(() => 'blob:http://localhost/download')
      // 补齐下载边界，避免 jsdom 缺少 Blob URL API 掩盖状态码校验失效。
      vi.stubGlobal(
        'URL',
        class extends URL {
          static override createObjectURL = createObjectURL
          static override revokeObjectURL() {}
        },
      )
      const anchorClick = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {})
      await renderWithProviders(
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
      expect(createObjectURL).not.toHaveBeenCalled()
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
    await renderWithProviders(
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

  it('只有完成且有结果的记录能进编辑，把那条记录交给调用方，并显示已编辑几次', async () => {
    const onEditVideo = vi.fn()
    await renderWithProviders(
      <GenerationRecords
        editCounts={new Map([['a', 2]])}
        jobs={jobs}
        onClose={() => {}}
        onEditPrompt={() => {}}
        onEditVideo={onEditVideo}
        shotIndex={2}
      />,
    )
    const button = screen.getByRole('button', { name: /^编辑视频/ })
    expect(screen.getAllByRole('button', { name: /^编辑视频/ })).toHaveLength(1)
    expect(button).toHaveTextContent('已编辑 2 次')
    await userEvent.click(button)
    expect(onEditVideo).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it.each([
    { status: 'submitted', outputUrl: 'take.mp4' },
    { status: 'failed', outputUrl: 'take.mp4' },
    { status: 'completed', outputUrl: null },
    { status: 'completed', outputUrl: '  ' },
  ] satisfies Partial<GenerationJob>[])(
    '状态 $status、结果 $outputUrl 不可编辑时没有入口',
    async (spec) => {
      await renderWithProviders(
        <GenerationRecords
          jobs={[job({ id: 'unavailable', ...spec })]}
          onClose={() => {}}
          onEditVideo={() => {}}
          shotIndex={2}
        />,
      )
      expect(screen.queryByRole('button', { name: /^编辑视频/ })).not.toBeInTheDocument()
    },
  )

  it('只读时没有编辑视频入口', async () => {
    await renderWithProviders(<GenerationRecords jobs={jobs} onClose={() => {}} shotIndex={2} />)
    expect(screen.queryByRole('button', { name: /^编辑视频/ })).not.toBeInTheDocument()
  })

  it('时刻写成年月日时分', async () => {
    await renderRecords()
    expect(screen.getByText('2026-09-01 12:20')).toBeVisible()
  })

  it('折叠箭头收起之后隐藏运行中的描述', async () => {
    await renderRecords()
    const card = cardWith('第三版：脚步放慢。')

    await userEvent.click(within(card).getByRole('button', { name: '收起这条记录' }))

    expect(within(card).queryByText('第三版：脚步放慢。')).not.toBeInTheDocument()
    expect(within(card).queryByText('模型 · moyu-seedance-2-5')).not.toBeInTheDocument()
    expect(within(card).getByText('生成中')).toBeVisible()
  })

  it('只有正文的记录可以查看，但不能回填镜头组', async () => {
    await renderWithProviders(
      <GenerationRecords
        jobs={[job({ id: 'no-shot', request: { prompt: '模特走向镜头，停下微笑。' } })]}
        onClose={vi.fn()}
        onEditPrompt={() => {}}
        shotIndex={2}
      />,
    )

    expect(screen.getByText('模特走向镜头，停下微笑。')).toBeVisible()
    expect(screen.getByRole('button', { name: '编辑生成' })).toBeDisabled()
  })

  it('收起已完成记录隐藏描述与编辑按钮，视频预览和播放入口仍保留', async () => {
    await renderRecords()
    const card = cardWith('第一版：走向镜头。')

    await userEvent.click(within(card).getByRole('button', { name: '收起这条记录' }))

    expect(within(card).queryByText('视频描述')).not.toBeInTheDocument()
    expect(within(card).queryByText('第一版：走向镜头。')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '编辑生成' })).not.toBeInTheDocument()
    const play = within(card).getByRole('button', { name: '播放视频' })
    expect(play).toBeVisible()
    expect(screen.queryByLabelText('生成的视频', { selector: 'video' })).toBeNull()

    await userEvent.click(play)
    const dialog = await screen.findByRole('dialog', { name: '生成的视频' })
    expect(within(dialog).getByLabelText('生成的视频')).toHaveAttribute('src', 'take-1.mp4')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '生成的视频' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('生成的视频', { selector: 'video' })).toBeNull()
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
      const { container } = await renderWithProviders(
        <GenerationRecords
          jobs={[job({ id: 'preview', outputUrl: url })]}
          onClose={vi.fn()}
          onEditPrompt={vi.fn()}
          shotIndex={2}
        />,
      )
      const play = screen.getByRole('button', { name: '播放视频' })
      expect(screen.queryByLabelText('生成的视频', { selector: 'video' })).toBeNull()
      const poster = within(play).queryByRole('img', { name: '生成的视频封面' })
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
      expect(screen.getAllByLabelText('生成的视频', { selector: 'video' })).toHaveLength(1)

      await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

      expect(screen.queryByRole('dialog', { name: '生成的视频' })).not.toBeInTheDocument()
      expect(screen.queryByLabelText('生成的视频', { selector: 'video' })).toBeNull()
      await waitFor(() => expect(play).toHaveFocus())
    },
  )

  it('只有图片或其它组的视频时，当前组仍显示空态', async () => {
    await renderWithProviders(
      <GenerationRecords
        jobs={jobs.filter((item) => item.kind === 'image' || item.id === 'other-shot')}
        onClose={vi.fn()}
        onEditPrompt={vi.fn()}
        shotIndex={2}
      />,
    )
    expect(screen.getByText('暂无视频记录')).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })
})
