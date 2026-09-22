import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import type { PendingEdit } from './edit-chain'
import { EditorGenerationStatus } from './editor-generation-status'

const failedJob: GenerationJob = {
  id: 'failed-job',
  kind: 'video',
  status: 'failed',
  createdAt: '2026-09-16T10:00:00Z',
  errorMessage: '上游服务暂时不可用',
  metadata: null,
  outputUrl: null,
  request: {},
  taskId: null,
  rootJobId: 'root',
  clipStage: null,
  durationMs: null,
  watermarkOutputUrl: null,
}

const edit = (changes: Partial<PendingEdit>): PendingEdit => ({
  key: 'edit-1',
  label: 'V2',
  base: {
    key: 'root',
    jobId: 'root',
    label: 'V1',
    mediaUrl: 'https://example.com/original.mp4',
    createdAt: failedJob.createdAt,
    edit: undefined,
  },
  stage: 'cutting',
  coords: { editId: 'edit-1', editStart: 0, editEnd: 3 },
  prompt: undefined,
  error: undefined,
  createdAt: failedJob.createdAt,
  reference: undefined,
  video: undefined,
  master: undefined,
  preview: undefined,
  ...changes,
})

describe('EditorGenerationStatus', () => {
  it.each([
    { stage: 'cutting', current: '切片准备，当前阶段', completed: 0 },
    { stage: 'cut', current: '视频生成，当前阶段', completed: 1 },
    { stage: 'generating', current: '视频生成，当前阶段', completed: 1 },
  ] as const)('$stage 按真实阶段标记进度', async ({ stage, current, completed }) => {
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage })} />)
    const status = screen.getByRole('status', { name: '视频编辑进度' })
    const steps = within(status).getByRole('list', { name: '生成阶段' })
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3)
    expect(within(steps).getByRole('listitem', { name: current })).toHaveAttribute(
      'aria-current',
      'step',
    )
    expect(within(steps).queryAllByRole('listitem', { name: /已完成/ })).toHaveLength(completed)
    expect(within(status).queryByRole('button')).not.toBeInTheDocument()
    expect(within(status).queryByRole('link')).not.toBeInTheDocument()
  })

  it.each(['ready', 'composing'] as const)('%s 不将预览或合成误报为成片完成', async (stage) => {
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage })} />)
    const status = screen.getByRole('status', { name: '视频编辑进度' })
    expect(status).toHaveTextContent(stage === 'ready' ? '待预览' : '正在合成成片')
    expect(within(status).getAllByRole('listitem', { name: /已完成/ })).toHaveLength(2)
    expect(within(status).getByRole('listitem', { name: '结果预览，当前阶段' })).toHaveAttribute(
      'aria-current',
      'step',
    )
    expect(
      within(status).queryByRole('listitem', { name: '结果预览，已完成' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    { stage: 'cutting', job: 'reference', clipStage: 'processing', text: '正在截取参考片段' },
    { stage: 'cutting', job: 'reference', clipStage: 'uploading', text: '正在上传参考片段' },
    { stage: 'composing', job: 'master', clipStage: 'fetching', text: '正在取素材' },
    { stage: 'composing', job: 'master', clipStage: 'processing', text: '正在编码成片' },
    { stage: 'composing', job: 'master', clipStage: 'uploading', text: '正在上传成片' },
  ] as const)('$stage 显示后端报的加工阶段：$text', async ({ stage, job, clipStage, text }) => {
    const running: GenerationJob = { ...failedJob, status: 'submitting', clipStage }
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage, [job]: running })} />)

    expect(screen.getByRole('status', { name: '视频编辑进度' })).toHaveTextContent(text)
  })

  it.each([
    { stage: 'cutting', job: 'reference', text: '等待切片' },
    { stage: 'composing', job: 'master', text: '等待合成' },
  ] as const)('$stage 还在本系统排队时说清是在等：$text', async ({ stage, job, text }) => {
    const queued: GenerationJob = { ...failedJob, status: 'pending' }
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage, [job]: queued })} />)

    expect(screen.getByRole('status', { name: '视频编辑进度' })).toHaveTextContent(text)
  })

  it.each([
    { stage: 'cutting', text: '正在准备参考片段' },
    { stage: 'composing', text: '正在合成成片' },
  ] as const)('$stage 没有阶段可读时回落到原文案', async ({ stage, text }) => {
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage })} />)

    expect(screen.getByRole('status', { name: '视频编辑进度' })).toHaveTextContent(text)
  })

  it.each([
    { failedAt: 'reference', failedStep: '切片准备，失败', completed: 0 },
    { failedAt: 'video', failedStep: '视频生成，失败', completed: 1 },
    { failedAt: 'master', failedStep: '结果预览，失败', completed: 2 },
  ] as const)(
    '$failedAt 失败时保留错误并停止该阶段',
    async ({ failedAt, failedStep, completed }) => {
      await renderWithProviders(
        <EditorGenerationStatus
          edit={edit({
            stage: 'failed',
            [failedAt]: failedJob,
            error: failedJob.errorMessage ?? undefined,
          })}
        />,
      )
      const status = screen.getByRole('status', { name: '视频编辑进度' })
      expect(status).toHaveTextContent('上游服务暂时不可用')
      expect(within(status).getByRole('listitem', { name: failedStep })).toHaveAttribute(
        'aria-current',
        'step',
      )
      expect(within(status).queryAllByRole('listitem', { name: /已完成/ })).toHaveLength(completed)
      expect(within(status).queryByRole('listitem', { name: /当前阶段/ })).not.toBeInTheDocument()
    },
  )
})
