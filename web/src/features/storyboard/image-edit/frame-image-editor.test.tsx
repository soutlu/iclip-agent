import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import { FrameImageEditor } from './frame-image-editor'
import { editDraftKey } from './image-edit-draft'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
  artifactPath: 'video_shot.json',
  shotIndex: 1,
  frameNumber: 1,
}
const BASE = 'https://example.com/original.png'
const RESULT = 'https://example.com/old-result.png'
const draft: FrameEditDraft = {
  annotations: [],
  instructions: [{ kind: 'text', text: '将衣服改成蓝色' }],
  references: [{ id: 'base', kind: 'image', url: BASE, label: '编辑底图' }],
}
const job = (over: Partial<GenerationJob> = {}): GenerationJob => ({
  id: crypto.randomUUID(),
  metadata: { frame: 1, path: target.artifactPath, shot: 1, sourceUrl: BASE },
  kind: 'image',
  status: 'pending',
  createdAt: '2026-09-07T12:00:00Z',
  errorMessage: null,
  outputUrl: null,
  request: { prompt: '将衣服改成蓝色', referenceImageUrls: [BASE] },
  taskId: null,
  watermarkOutputUrl: null,
  ...over,
})

function EditorPage({ initialKey }: { initialKey?: string }) {
  const [open, setOpen] = useState(true)
  const [frames, setFrames] = useState([BASE])
  return (
    <>
      {open && (
        <FrameImageEditor
          target={target}
          frames={frames}
          aspectRatio="9:16"
          initialKey={initialKey}
          onClose={() => setOpen(false)}
          onApply={async (_previous, url) => setFrames([url])}
        />
      )}
      <Toaster />
    </>
  )
}

describe('图片编辑器', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    sessionStorage.clear()
    sessionStorage.setItem(editDraftKey(target), JSON.stringify({ [BASE]: draft }))
  })
  afterEach(() => {
    // Toaster 是模块级单例，上一条用例弹出的提示不清掉会串进下一条。
    toast.dismiss()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('换成没有渠道轴的模型后，渠道那栏不再渲染，档位也收敛到它支持的范围', async () => {
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: job() }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage />)

    const models = await screen.findByLabelText('图片模型')
    expect(await screen.findByLabelText('图片生成渠道')).toBeInTheDocument()

    await userEvent.selectOptions(models, 'seedream_v5_pro')

    await waitFor(() => expect(screen.queryByLabelText('图片生成渠道')).not.toBeInTheDocument())
    const resolutions = within(screen.getByLabelText('图片分辨率')).getAllByRole('option')
    expect(resolutions.map((option) => option.textContent)).toEqual(['1K', '2K'])

    await userEvent.click(screen.getByRole('button', { name: '生成编辑结果' }))
    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]?.['model']).toBe('seedream_v5_pro')
    expect(submissions[0]?.['channel']).toBeUndefined()
    expect(submissions[0]?.['metadata']).toMatchObject({ sourceUrl: BASE })
  })

  it('提交后新任务占一格并自动选中；草稿暂存与记录刷新都失败也不挡着看在途任务', async () => {
    const completed = job({ status: 'completed', outputUrl: RESULT })
    const pending = job()
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return reads === 1
          ? HttpResponse.json({ items: [completed] })
          : HttpResponse.json({ detail: '记录刷新失败' }, { status: 503 })
      }),
      http.post('*/api/generations/image', () =>
        HttpResponse.json({ generation: pending }, { status: 202 }),
      ),
    )
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    await within(strip).findByRole('button', { name: /^结果 · / })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError')
    })

    await userEvent.click(within(editor).getByRole('button', { name: '生成编辑结果' }))

    expect(await screen.findByText('编辑草稿无法暂存，关闭页面前请先提交生成')).toBeVisible()
    const queued = await within(strip).findByRole('button', { name: /^排队中 · / })
    expect(queued).toHaveAttribute('aria-pressed', 'true')
    expect(await within(editor).findByText('图片排队中，关掉窗口也会继续')).toBeVisible()
    expect(await within(editor).findByText(/记录刷新失败/)).toBeVisible()
    // 在途任务没有产出，应用照旧在原位但按不动。
    expect(within(editor).getByRole('button', { name: '应用到当前帧' })).toBeDisabled()
  })

  it('从帧上的新结果进来就选中它，应用之后窗口留着且那张成了当前帧', async () => {
    const completed = job({ status: 'completed', outputUrl: RESULT })
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })))
    await renderWithProviders(<EditorPage initialKey={completed.id} />)

    const editor = await screen.findByRole('dialog')
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    await waitFor(() =>
      expect(within(strip).getByRole('button', { name: /^结果 · / })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(within(editor).getByRole('img', { name: '图片编辑结果' })).toHaveAttribute('src', RESULT)

    const apply = within(editor).getByRole('button', { name: '应用到当前帧' })
    expect(apply).toBeEnabled()
    await userEvent.click(apply)

    expect(await screen.findByText('已应用到当前帧')).toBeVisible()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(strip).getByRole('button', { name: '当前帧' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    // 折进当前帧格之后不再是一张「还没应用」的结果，应用按不动了。
    expect(within(editor).getByRole('button', { name: '应用到当前帧' })).toBeDisabled()
    expect(within(strip).queryByRole('button', { name: /^结果 · / })).not.toBeInTheDocument()
    // 被换下来的那张留在条里，选中它就能换回去。
    const previous = within(strip).getByRole('button', { name: /^上一版 · / })
    await userEvent.click(previous)
    expect(within(editor).getByRole('button', { name: '应用到当前帧' })).toBeEnabled()
  })
})
