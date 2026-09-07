import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/shared/ui/toast'
import { writeWorkspaceFile } from '@/shared/workbench'
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
  sourceUrl: 'https://example.com/original.png',
}
const draft: FrameEditDraft = {
  annotations: [],
  instructions: [{ kind: 'text', text: '将衣服改成蓝色' }],
  references: [{ id: 'original', kind: 'image', url: target.sourceUrl, label: '原图' }],
}
const job = (status: 'pending' | 'completed'): GenerationJob => ({
  id: crypto.randomUUID(),
  conversationId: target.conversationId,
  shotIndex: target.shotIndex,
  kind: 'image',
  status,
  createdAt: '2026-09-07T12:00:00Z',
  updatedAt: '2026-09-07T12:00:00Z',
  submittedAt: null,
  finishedAt: null,
  provider: 'mock',
  providerStatus: null,
  errorCode: null,
  errorMessage: null,
  outputUrl: status === 'completed' ? 'https://example.com/old-result.png' : null,
  request: { frameEdit: { ...target, ...draft } },
})

function EditorPage({ onApply }: { onApply: (url: string) => Promise<void> }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      {open && (
        <FrameImageEditor
          target={target}
          frames={[target.sourceUrl]}
          aspectRatio="9:16"
          onClose={() => setOpen(false)}
          onApply={onApply}
        />
      )}
      <Toaster />
    </>
  )
}

describe('图片编辑提交与应用的失败边界', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    sessionStorage.clear()
    sessionStorage.setItem(editDraftKey(target), JSON.stringify(draft))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('POST 成功后草稿暂存与记录刷新失败，仍显示新任务生成中且不提供旧结果应用', async () => {
    const completed = job('completed')
    const pending = job('pending')
    const submissions: unknown[] = []
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return reads === 1
          ? HttpResponse.json({ items: [completed] })
          : HttpResponse.json({ detail: '记录刷新失败' }, { status: 503 })
      }),
      http.post('*/api/generations', async ({ request }) => {
        submissions.push(await request.json())
        return HttpResponse.json({ generation: pending }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage onApply={async () => {}} />)
    const editor = await screen.findByRole('dialog', { name: '编辑图片' })
    await within(editor).findByRole('button', { name: '查看编辑结果' })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError')
    })

    await userEvent.click(within(editor).getByRole('button', { name: '生成编辑结果' }))

    expect(await screen.findByText('图片编辑已提交，可以关闭窗口，稍后查看结果')).toBeVisible()
    expect(await screen.findByText('编辑草稿无法暂存，关闭页面前请先提交生成')).toBeVisible()
    expect(await within(editor).findByText('图片生成中，关闭窗口后仍会继续')).toBeVisible()
    await userEvent.click(within(editor).getByText(/^编辑记录/))
    expect(await within(editor).findByText(/记录刷新失败/)).toBeVisible()
    expect(submissions).toHaveLength(1)
    expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
    expect(within(editor).queryByRole('button', { name: '查看编辑结果' })).not.toBeInTheDocument()
    expect(within(editor).getByRole('button', { name: '编辑结果' })).toBeDisabled()
    expect(within(editor).queryByText(/图片编辑提交失败/)).not.toBeInTheDocument()
    await userEvent.click(within(editor).getByRole('button', { name: '关闭图片编辑' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑图片' })).not.toBeInTheDocument(),
    )
    expect(submissions).toHaveLength(1)
  })

  it('服务端保存成功后清理本地草稿失败，仍报告已应用并关闭编辑器', async () => {
    const completed = job('completed')
    const writes: { content: string }[] = []
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })),
      http.put('*/api/conversations/:id/workspace/file', async ({ request }) => {
        const body = (await request.json()) as { content: string; path: string }
        writes.push(body)
        return HttpResponse.json({ file: { content: body.content, path: body.path, version: 2 } })
      }),
    )
    await renderWithProviders(
      <EditorPage
        onApply={async (url) => {
          await writeWorkspaceFile(target.conversationId, {
            path: target.artifactPath,
            expectedVersion: 1,
            content: JSON.stringify({
              aspectRatio: '9:16',
              shots: [{ index: 1, imageUrls: [url], prompt: '原有描述', seconds: 6 }],
            }),
          })
        }}
      />,
    )
    const editor = await screen.findByRole('dialog', { name: '编辑图片' })
    await userEvent.click(await within(editor).findByRole('button', { name: '查看编辑结果' }))
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })

    await userEvent.click(within(editor).getByRole('button', { name: '应用到当前帧' }))

    expect(await screen.findByText('图片已应用并保存到当前帧')).toBeVisible()
    expect(await screen.findByText('图片已保存，但本地草稿清理失败')).toBeVisible()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑图片' })).not.toBeInTheDocument(),
    )
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]?.content ?? '{}')).toMatchObject({
      shots: [{ imageUrls: [completed.outputUrl] }],
    })
    expect(screen.queryByText(/图片尚未应用/)).not.toBeInTheDocument()
  })
})
