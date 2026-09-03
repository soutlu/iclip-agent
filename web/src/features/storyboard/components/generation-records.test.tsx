import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
  render(<GenerationRecords jobs={jobs} onClose={onClose} shotIndex={2} />)
  return onClose
}

describe('GenerationRecords', () => {
  it('视频 tab 只列本组的，按时间倒序', () => {
    renderRecords()

    expect(screen.getByRole('radio', { name: '视频生成记录 3' })).toBeVisible()
    expect(screen.queryByText('别的组。')).not.toBeInTheDocument()

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

  it('折叠箭头收起之后只留第一行', async () => {
    renderRecords()
    const card = screen.getByText('第三版：脚步放慢。').closest('article') as HTMLElement

    await userEvent.click(within(card).getByRole('button', { name: '收起这条记录' }))

    expect(within(card).queryByText('第三版：脚步放慢。')).not.toBeInTheDocument()
    expect(within(card).getByText('生成中…')).toBeVisible()
  })

  it('换到分镜 tab 看的是这段对话的出帧任务，标签也跟着换', async () => {
    renderRecords()

    await userEvent.click(screen.getByRole('radio', { name: '分镜生成记录 1' }))

    expect(screen.getByText('出镜头帧：门厅全景。')).toBeVisible()
    expect(screen.getByText('分镜描述')).toBeVisible()
    expect(screen.queryByText('第三版：脚步放慢。')).not.toBeInTheDocument()
  })

  it('再点一次当前 tab 不会把列表点空', async () => {
    renderRecords()
    const current = screen.getByRole('radio', { name: '视频生成记录 3' })

    await userEvent.click(current)

    expect(screen.getByText('第三版：脚步放慢。')).toBeVisible()
  })

  it('一条都没有时说一句，不留空白', async () => {
    render(<GenerationRecords jobs={[]} onClose={vi.fn()} shotIndex={2} />)
    expect(screen.getByText('还没有生成记录')).toBeVisible()
  })

  it('✕ 关掉抽屉', async () => {
    const onClose = renderRecords()
    await userEvent.click(screen.getByRole('button', { name: '关闭生成记录' }))
    expect(onClose).toHaveBeenCalled()
  })
})
