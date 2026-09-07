import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerationJob } from '../storyboard.api'
import { GenerationRecords } from './generation-records'

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob => ({
  conversationId: null,
  createdAt: '2026-09-01T10:00:00Z',
  errorCode: null,
  errorMessage: null,
  finishedAt: null,
  kind: 'video',
  outputUrl: null,
  provider: 'mock',
  providerStatus: null,
  request: {},
  shotIndex: 2,
  status: 'completed',
  submittedAt: null,
  updatedAt: '2026-09-01T10:00:00Z',
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GenerationRecords', () => {
  it('只列本组视频，排除图片和其它组，按时间倒序', () => {
    renderRecords()

    expect(screen.getByRole('heading', { name: '视频生成记录' })).toBeVisible()
    expect(screen.getByText('3', { exact: true })).toBeVisible()
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

  it('编辑生成交出完整历史提示词，保留超过三行的内容和原始空白', async () => {
    const prompt =
      '  产品：黑色短靴。\n人物与场景：客厅模特。\n剪辑形式：硬切。\n\n[0–2秒｜镜头1]\n走近 @Image1。\n[2–6秒｜镜头2]\n停下 @Image2。\n不要生成字幕。  \n'
    const onEditPrompt = vi.fn()
    render(
      <GenerationRecords
        jobs={[job({ id: 'long-prompt', request: { prompt } })]}
        onClose={vi.fn()}
        onEditPrompt={onEditPrompt}
        shotIndex={2}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: '编辑生成' }))

    expect(onEditPrompt).toHaveBeenCalledExactlyOnceWith(prompt)
  })

  it.each([undefined, null, 123, '', '  \n '])(
    '没有有效提示词 %s 时禁用编辑生成',
    async (prompt) => {
      const onEditPrompt = vi.fn()
      render(
        <GenerationRecords
          jobs={[job({ id: 'no-prompt', request: prompt === undefined ? {} : { prompt } })]}
          onClose={vi.fn()}
          onEditPrompt={onEditPrompt}
          shotIndex={2}
        />,
      )

      const edit = screen.getByRole('button', { name: '编辑生成' })
      expect(edit).toBeDisabled()
      await userEvent.click(edit)
      expect(onEditPrompt).not.toHaveBeenCalled()
    },
  )

  it('收起已完成记录隐藏描述与编辑按钮，视频预览和播放入口仍保留', async () => {
    renderRecords()
    const card = screen.getByText('第一版：走向镜头。').closest('article') as HTMLElement

    await userEvent.click(within(card).getByRole('button', { name: '收起这条记录' }))

    expect(within(card).queryByText('视频描述')).not.toBeInTheDocument()
    expect(within(card).queryByText('第一版：走向镜头。')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '编辑生成' })).not.toBeInTheDocument()
    expect(within(card).getByLabelText('生成的视频')).toHaveAttribute('src', 'take-1.mp4')
    expect(within(card).getByRole('button', { name: '播放视频' })).toBeVisible()

    await userEvent.click(within(card).getByRole('button', { name: '展开这条记录' }))
    expect(within(card).getByText('第一版：走向镜头。')).toBeVisible()
    expect(within(card).getByRole('button', { name: '编辑生成' })).toBeEnabled()
  })

  it('点击视频封面调用媒体播放，成功后显示原生控制条', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    renderRecords()
    const video = screen.getByLabelText('生成的视频')
    expect(video).not.toHaveAttribute('controls')

    await userEvent.click(screen.getByRole('button', { name: '播放视频' }))

    expect(play).toHaveBeenCalledOnce()
    await waitFor(() => expect(video).toHaveAttribute('controls'))
    expect(screen.queryByRole('button', { name: '播放视频' })).not.toBeInTheDocument()
  })

  it('只有图片或其它组的视频时，当前组仍显示空态', () => {
    render(
      <GenerationRecords
        jobs={jobs.filter((item) => item.kind === 'image' || item.shotIndex === 3)}
        onClose={vi.fn()}
        onEditPrompt={vi.fn()}
        shotIndex={2}
      />,
    )
    expect(screen.getByText('0', { exact: true })).toBeVisible()
    expect(screen.getByText('还没有生成记录')).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('一条都没有时说一句，不留空白', async () => {
    render(<GenerationRecords jobs={[]} onClose={vi.fn()} onEditPrompt={vi.fn()} shotIndex={2} />)
    expect(screen.getByText('还没有生成记录')).toBeVisible()
  })

  it('✕ 关掉抽屉', async () => {
    const onClose = renderRecords()
    await userEvent.click(screen.getByRole('button', { name: '关闭生成记录' }))
    expect(onClose).toHaveBeenCalled()
  })
})
