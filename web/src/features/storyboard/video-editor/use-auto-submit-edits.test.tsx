import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import type { ChainVersion, PendingEdit } from './edit-chain'
import { useAutoSubmitEdits, type EditDraft } from './use-auto-submit-edits'

const ROOT_URL = 'https://example.com/root.mp4'
const CLIP_URL = 'https://example.com/reference.mp4'
const root: ChainVersion = {
  key: 'root',
  jobId: 'root',
  label: 'V1',
  mediaUrl: ROOT_URL,
  createdAt: '2026-09-16T10:00:00Z',
  edit: undefined,
}
const origin = { conversationId: 'conversation-1', taskId: null, rootJobId: 'root' }
const draft: EditDraft = { prompt: '把背景换成海边', model: 'moyu-seedance-2-5', references: [] }

/** 参考片段已切好、编辑任务还没发的那一条。 */
const cutEdit = (): PendingEdit => ({
  key: 'edit-1',
  label: 'V2',
  base: root,
  stage: 'cut',
  coords: { editId: 'edit-1', editStart: 1, editEnd: 3 },
  prompt: undefined,
  error: undefined,
  createdAt: '2026-09-16T10:01:00Z',
  reference: makeGenerationJob({
    kind: 'clip',
    outputUrl: CLIP_URL,
    durationMs: 2400,
    rootJobId: 'root',
  }),
  video: undefined,
  master: undefined,
  preview: undefined,
})

type Props = { pending: readonly PendingEdit[]; drafts: Readonly<Record<string, EditDraft>> }

const renderAutoSubmit = (
  onError: (message: string) => void,
  initialProps: Props = { pending: [cutEdit()], drafts: { 'edit-1': draft } },
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook<void, Props>((props) => useAutoSubmitEdits({ ...props, origin, onError }), {
    wrapper,
    initialProps,
  })
}

describe('useAutoSubmitEdits', () => {
  it('切好的片段带着草稿只发一次编辑任务，重渲染不重发', async () => {
    let posts = 0
    server.use(
      http.post('*/api/generations/video', () => {
        posts += 1
        return HttpResponse.json({ task_id: crypto.randomUUID() }, { status: 202 })
      }),
    )
    const errors: string[] = []
    const { rerender } = renderAutoSubmit((message) => errors.push(message))

    await waitFor(() => expect(posts).toBe(1))
    rerender({ pending: [cutEdit()], drafts: { 'edit-1': draft } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(posts).toBe(1)
    expect(errors).toEqual([])
  })

  it('提交失败只报一次错，不会一渲染一次地重试', async () => {
    let posts = 0
    server.use(
      http.post('*/api/generations/video', () => {
        posts += 1
        return HttpResponse.json({ detail: '上游拒绝了这次编辑' }, { status: 502 })
      }),
    )
    const errors: string[] = []
    const { rerender } = renderAutoSubmit((message) => errors.push(message))

    await waitFor(() => expect(errors).toEqual(['视频编辑提交失败：上游拒绝了这次编辑']))
    rerender({ pending: [cutEdit()], drafts: { 'edit-1': draft } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(posts).toBe(1)
    expect(errors).toHaveLength(1)
  })

  it('没有草稿或还没切好的编辑不发', async () => {
    let posts = 0
    server.use(
      http.post('*/api/generations/video', () => {
        posts += 1
        return HttpResponse.json({ task_id: crypto.randomUUID() }, { status: 202 })
      }),
    )
    const { rerender } = renderAutoSubmit(() => {}, { pending: [cutEdit()], drafts: {} })
    rerender({ pending: [{ ...cutEdit(), stage: 'cutting' }], drafts: { 'edit-1': draft } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(posts).toBe(0)
  })
})
