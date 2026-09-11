import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceQueryKeys, type ArtifactRendererProps } from '@/shared/workbench'
import { pasteTextIntoComposer } from '@/testing/editor'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ShotsDocument } from '../shot-document'
import type { GenerationJob } from '../storyboard.api'
import { StoryboardReader } from './storyboard-reader'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
const PATH = 'video_shot.json'
const ORIGINAL = 'https://example.com/original.png'
const CANDIDATE_A = 'https://example.com/candidate-a.png'
const CANDIDATE_B = 'https://example.com/candidate-b.png'
const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${PATH}`,
  source: { kind: 'file', path: PATH, version: 1 },
  title: '分镜',
  type: 'storyboard',
}
const originalDocument = (): ShotsDocument => ({
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      seconds: 6,
      image_urls: [ORIGINAL],
      prompt: {
        global_settings: '人物保持一致。',
        timeline: [{ timestamps: [0, 6], prompt: '原有描述 @Image1。', image_indexes: [1] }],
      },
    },
  ],
})

const completedJob = (outputUrl: string, createdAt: string): GenerationJob => ({
  id: crypto.randomUUID(),
  kind: 'image',
  shotIndex: 1,
  createdAt,
  status: 'completed',
  outputUrl,
  errorMessage: null,
  request: { frameNumber: 1, prompt: '修改颜色', referenceImageUrls: [ORIGINAL] },
  taskId: null,
  watermarkOutputUrl: null,
})

const provideJobs = () => {
  const jobs = [
    completedJob(CANDIDATE_A, '2026-09-07T12:00:00Z'),
    completedJob(CANDIDATE_B, '2026-09-07T11:00:00Z'),
  ]
  server.use(
    http.get('*/api/generations', ({ request }) =>
      HttpResponse.json({
        items: new URL(request.url).searchParams.get('kind') === 'image' ? jobs : [],
      }),
    ),
    http.get('*/api/conversations/:id/workspace/files', () =>
      HttpResponse.json({ files: [{ path: PATH, version: 1 }] }),
    ),
  )
}

const renderReader = () =>
  renderWithProviders(<StoryboardReader artifact={artifact} conversationId={CONVERSATION_ID} />, {
    initialPath: '/?content=scene:1',
  })

describe('图片编辑结果应用', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    provideJobs()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('应用 A 保存失败后恢复原图，保留描述并允许直接改选 B 保存', async () => {
    let persisted = originalDocument()
    let version = 1
    const writes: ShotsDocument[] = []
    let release = () => {}
    const savingA = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('*/api/conversations/:id/workspace/file', () =>
        HttpResponse.json({ file: { path: PATH, content: JSON.stringify(persisted), version } }),
      ),
      http.put('*/api/conversations/:id/workspace/file', async ({ request }) => {
        const body = (await request.json()) as { content: string; expectedVersion: number }
        const document = JSON.parse(body.content) as ShotsDocument
        writes.push(document)
        if (document.shots[0]?.image_urls[0] === CANDIDATE_A) {
          await savingA
          return HttpResponse.json({ detail: '保存暂时失败' }, { status: 503 })
        }
        expect(body.expectedVersion).toBe(version)
        persisted = document
        version += 1
        return HttpResponse.json({ file: { path: PATH, content: body.content, version } })
      }),
    )
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const description = within(page).getByRole('textbox', { name: '镜头 1 的描述' })
    description.focus()
    pasteTextIntoComposer(description, '同时修改的描述')
    await userEvent.click(within(page).getByRole('button', { name: '编辑图片' }))
    const editor = await screen.findByRole('dialog', { name: '编辑图片' })
    await userEvent.click(await within(editor).findByRole('button', { name: '查看编辑结果' }))
    await userEvent.click(within(editor).getByRole('button', { name: '应用到当前帧' }))
    try {
      await waitFor(() =>
        expect(writes.some((item) => item.shots[0]?.image_urls[0] === CANDIDATE_A)).toBe(true),
      )
      expect(screen.getByRole('dialog', { name: '编辑图片' })).toBeVisible()
      expect(persisted.shots[0]?.image_urls).toEqual([ORIGINAL])
    } finally {
      release()
    }
    await within(editor).findByText('图片尚未保存，请处理保存错误或冲突后重试')
    expect(
      within(page).getByRole('img', { name: '镜头组 1 第 1 帧', hidden: true }),
    ).toHaveAttribute('src', ORIGINAL)
    await userEvent.click(within(editor).getByText(/编辑记录/))
    const records = within(editor).getAllByRole('button', { name: /已生成/ })
    const second = records[1]
    if (!second) throw new Error('缺少第二个候选结果')
    await userEvent.click(second)
    expect(within(editor).getByRole('img', { name: '图片编辑结果' })).toHaveAttribute(
      'src',
      CANDIDATE_B,
    )
    await userEvent.click(within(editor).getByRole('button', { name: '应用到当前帧' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑图片' })).not.toBeInTheDocument(),
    )
    expect(persisted.shots[0]?.image_urls).toEqual([CANDIDATE_B])
    expect(persisted.shots[0]?.prompt.timeline[0]?.prompt).toContain('同时修改的描述')
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
      'src',
      CANDIDATE_B,
    )
    expect(writes.filter((item) => item.shots[0]?.image_urls[0] === CANDIDATE_A)).toHaveLength(1)
  })

  it('编辑器打开后原图被外部修改时，拒绝应用并保留外部图片', async () => {
    let persisted = originalDocument()
    let version = 1
    const writes: unknown[] = []
    server.use(
      http.get('*/api/conversations/:id/workspace/file', () =>
        HttpResponse.json({ file: { path: PATH, content: JSON.stringify(persisted), version } }),
      ),
      http.put('*/api/conversations/:id/workspace/file', async ({ request }) => {
        writes.push(await request.json())
        return HttpResponse.json({ detail: '不应覆盖外部修改' }, { status: 409 })
      }),
    )
    const { queryClient } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '编辑图片' }))
    const editor = await screen.findByRole('dialog', { name: '编辑图片' })
    await userEvent.click(await within(editor).findByRole('button', { name: '查看编辑结果' }))
    const externalUrl = 'https://example.com/external.png'
    persisted = {
      ...persisted,
      shots: persisted.shots.map((shot) => ({ ...shot, image_urls: [externalUrl] })),
    }
    version += 1
    await act(() =>
      queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.file(CONVERSATION_ID, PATH) }),
    )
    await userEvent.click(within(editor).getByRole('button', { name: '应用到当前帧' }))
    expect(
      await within(editor).findByText('这张图片已发生变化，请重新选择要替换的图片'),
    ).toBeVisible()
    expect(writes).toHaveLength(0)
    expect(persisted.shots[0]?.image_urls).toEqual([externalUrl])
    expect(within(editor).getByRole('img', { name: '图片编辑结果' })).toHaveAttribute(
      'src',
      CANDIDATE_A,
    )
  })

  it('关闭编辑器后焦点回到入口按钮', async () => {
    const persisted = originalDocument()
    server.use(
      http.get('*/api/conversations/:id/workspace/file', () =>
        HttpResponse.json({ file: { path: PATH, content: JSON.stringify(persisted), version: 1 } }),
      ),
    )
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const entry = within(page).getByRole('button', { name: '编辑图片' })
    await userEvent.click(entry)
    const editor = await screen.findByRole('dialog', { name: '编辑图片' })
    expect(within(editor).getByText('镜头组 1 · 帧 @1')).toBeVisible()
    await userEvent.click(within(editor).getByRole('button', { name: '关闭图片编辑' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑图片' })).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(entry).toHaveFocus())
  })
})
