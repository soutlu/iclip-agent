import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useWorkspaceFile } from '@/shared/workbench'
import { server } from '@/testing/mocks/server'
import type { Shot, ShotsDocument } from './shot-document'
import { useShotsDraft } from './use-shots-draft'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
const PATH = 'video_shot.json'
const ENDPOINT = '*/api/conversations/:conversationId/workspace/file'

const initialDocument = (): ShotsDocument => ({
  aspect_ratio: '9:16',
  shots: [1, 2, 3].map((index) => ({
    index,
    seconds: 6,
    image_urls: [`https://example.com/frame-${index}.png`],
    prompt: {
      global_settings: `镜头组 ${index} 的全局设定`,
      timeline: [{ timestamps: [0, 6], prompt: `原镜头 ${index} @Image1`, image_indexes: [1] }],
    },
  })),
})

const withBody = (shot: Shot, body: string): Shot => ({
  ...shot,
  prompt: {
    ...shot.prompt,
    timeline: shot.prompt.timeline.map((item, position) =>
      position === 0 ? { ...item, prompt: `${body} @Image1` } : item,
    ),
  },
})

const changedBody = (document: ShotsDocument, index: number, body: string): ShotsDocument => ({
  ...document,
  shots: document.shots.map((shot) => (shot.index === index ? withBody(shot, body) : shot)),
})

type Write = { content: string; expectedVersion: number; path: string }
type WriteReply = (write: Write, count: number) => Promise<Response | undefined>

const serveWorkspace = (document = initialDocument(), reply?: WriteReply) => {
  let file = { content: JSON.stringify(document), path: PATH, version: 1 }
  const writes: Write[] = []
  server.use(
    http.get(ENDPOINT, () => HttpResponse.json({ file })),
    http.put(ENDPOINT, async ({ request }) => {
      const body = (await request.json()) as Write
      writes.push(body)
      const response = await reply?.(body, writes.length)
      if (response !== undefined) return response
      if (body.expectedVersion !== file.version) {
        return HttpResponse.json({ detail: '文件已更新' }, { status: 409 })
      }
      file = { content: body.content, path: body.path, version: file.version + 1 }
      return HttpResponse.json({ file })
    }),
  )
  return {
    writes,
    read: () => ({ document: JSON.parse(file.content) as ShotsDocument, version: file.version }),
    publish: (latest: ShotsDocument) => {
      file = { ...file, content: JSON.stringify(latest), version: file.version + 1 }
    },
  }
}

const cleanups: (() => void)[] = []

const renderDraft = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const hook = renderHook(
    () => {
      const file = useWorkspaceFile(CONVERSATION_ID, PATH)
      return useShotsDraft({ conversationId: CONVERSATION_ID, file: file.data?.file, path: PATH })
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
  cleanups.push(() => {
    hook.unmount()
    client.clear()
  })
  await waitFor(() => expect(hook.result.current.document).not.toBeNull())
  return hook.result
}

const saveDraft = async (result: { current: ReturnType<typeof useShotsDraft> }) => {
  let saved = false
  await act(async () => {
    saved = await result.current.saveNow()
  })
  return saved
}

const deferred = () => {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {
    promise,
    release: () => {
      if (resolve === undefined) throw new Error('响应闸门尚未初始化')
      resolve()
    },
  }
}

afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  cleanups.length = 0
})

describe('分镜草稿整份写回与版本冲突', () => {
  it('保存期间继续编辑，下一次请求使用新版本并包含两次修改，落盘前仍是保存中', async () => {
    const firstReply = deferred()
    const secondReply = deferred()
    const initial = initialDocument()
    const workspace = serveWorkspace(initial, async (_write, count) => {
      if (count === 1) await firstReply.promise
      if (count === 2) await secondReply.promise
      return undefined
    })
    const result = await renderDraft()
    let saving: Promise<boolean> | undefined
    const first = changedBody(initial, 1, '第一次修改')
    const both = changedBody(first, 2, '请求发出后的第二次修改')
    try {
      act(() => {
        result.current.updateShot(1, (shot) => withBody(shot, '第一次修改'))
        saving = result.current.saveNow()
      })
      await waitFor(() => expect(workspace.writes).toHaveLength(1))
      expect(workspace.writes[0]?.expectedVersion).toBe(1)
      expect(JSON.parse(workspace.writes[0]?.content ?? '{}')).toEqual(first)
      act(() => {
        result.current.updateShot(2, (shot) => withBody(shot, '请求发出后的第二次修改'))
      })
      expect(result.current.document).toEqual(both)
      expect(result.current.state.kind).toBe('saving')
      expect(result.current.hasUnsavedChanges).toBe(true)

      act(() => firstReply.release())
      await waitFor(() => expect(workspace.writes).toHaveLength(2))
      expect(workspace.writes[1]?.expectedVersion).toBe(2)
      expect(JSON.parse(workspace.writes[1]?.content ?? '{}')).toEqual(both)
      expect(workspace.read()).toEqual({ document: first, version: 2 })
      expect(result.current.document).toEqual(both)
      expect(result.current.state.kind).toBe('saving')
      expect(result.current.hasUnsavedChanges).toBe(true)

      await act(async () => {
        secondReply.release()
        expect(await saving).toBe(true)
      })
      await waitFor(() => expect(result.current.state.kind).toBe('saved'))
      expect(result.current.hasUnsavedChanges).toBe(false)
      expect(workspace.read()).toEqual({ document: both, version: 3 })
      expect(await saveDraft(result)).toBe(true)
      expect(workspace.writes).toHaveLength(2)
    } finally {
      await act(async () => {
        firstReply.release()
        secondReply.release()
        await saving
      })
    }
  })

  it('409 来自其它镜头组更新时自动重放本地修改，第二次写回保留服务端的新内容', async () => {
    const initial = initialDocument()
    const workspace = serveWorkspace(initial)
    const result = await renderDraft()
    const latest = changedBody(initial, 3, '服务端更新第三组')
    workspace.publish(latest)
    act(() => {
      result.current.updateShot(1, (shot) => withBody(shot, '本地更新第一组'))
    })

    expect(await saveDraft(result)).toBe(true)

    const expected = changedBody(latest, 1, '本地更新第一组')
    expect(workspace.writes.map((write) => write.expectedVersion)).toEqual([1, 2])
    expect(JSON.parse(workspace.writes[1]?.content ?? '{}')).toEqual(expected)
    expect(workspace.read()).toEqual({ document: expected, version: 3 })
    expect(result.current.state.kind).toBe('saved')
    expect(result.current.hasUnsavedChanges).toBe(false)
  })

  it('409 同组冲突选择最新内容时，只放弃冲突组并续存其它组的草稿', async () => {
    const initial = initialDocument()
    const workspace = serveWorkspace(initial)
    const result = await renderDraft()
    const latest = changedBody(initial, 1, '服务端更新第一组')
    workspace.publish(latest)
    act(() => {
      result.current.updateShot(1, (shot) => withBody(shot, '本地更新第一组'))
      result.current.updateShot(2, (shot) => withBody(shot, '本地更新第二组'))
    })

    expect(await saveDraft(result)).toBe(false)
    expect(result.current.state).toMatchObject({ kind: 'conflict', shots: [{ index: 1 }] })
    expect(workspace.writes).toHaveLength(1)
    expect(result.current.hasUnsavedChanges).toBe(true)
    act(() => result.current.resolveConflict('theirs'))

    await waitFor(() => expect(result.current.state.kind).toBe('saved'))
    const expected = changedBody(latest, 2, '本地更新第二组')
    expect(workspace.writes.map((write) => write.expectedVersion)).toEqual([1, 2])
    expect(workspace.read()).toEqual({ document: expected, version: 3 })
    expect(result.current.document).toEqual(expected)
    expect(result.current.hasUnsavedChanges).toBe(false)
  })

  it.each(['继续编辑', '上传回调'] as const)(
    '冲突期间另一组的%s也要重新与最新版本比较，不能绕过新增的同组冲突',
    async (operation) => {
      const initial = initialDocument()
      const workspace = serveWorkspace(initial)
      const result = await renderDraft()
      const latest = changedBody(changedBody(initial, 1, '外部第一组'), 2, '外部第二组')
      workspace.publish(latest)
      act(() => {
        result.current.updateShot(1, (shot) => withBody(shot, '我的第一组'))
      })
      expect(await saveDraft(result)).toBe(false)
      expect(result.current.state).toMatchObject({ kind: 'conflict', shots: [{ index: 1 }] })

      act(() => {
        if (operation === '上传回调') {
          result.current.replaceFrame(
            2,
            1,
            'https://example.com/frame-2.png',
            'https://example.com/uploaded-2.png',
          )
        } else {
          result.current.updateShot(2, (shot) => withBody(shot, '我的第二组'))
        }
        result.current.updateShot(3, (shot) => withBody(shot, '不冲突的第三组草稿'))
      })
      expect(result.current.state).toMatchObject({
        kind: 'conflict',
        shots: [{ index: 1 }, { index: 2 }],
      })
      expect(await saveDraft(result)).toBe(false)
      expect(workspace.writes).toHaveLength(1)
      expect(workspace.read()).toEqual({ document: latest, version: 2 })
      act(() => result.current.resolveConflict('theirs'))

      await waitFor(() => expect(result.current.state.kind).toBe('saved'))
      const expected = changedBody(latest, 3, '不冲突的第三组草稿')
      expect(workspace.writes.map((write) => write.expectedVersion)).toEqual([1, 2])
      expect(workspace.read()).toEqual({ document: expected, version: 3 })
      expect(result.current.document).toEqual(expected)
      expect(result.current.hasUnsavedChanges).toBe(false)
    },
  )

  it.each(['422', '网络失败'] as const)(
    '%s 保留完整草稿，重试使用原版本写回同一份内容',
    async (failure) => {
      const initial = initialDocument()
      const workspace = serveWorkspace(initial, async (_write, count) => {
        if (count !== 1) return undefined
        return failure === '422'
          ? HttpResponse.json({ detail: '正文不符合文件规则' }, { status: 422 })
          : HttpResponse.error()
      })
      const result = await renderDraft()
      const expected = changedBody(initial, 2, '需要保留的草稿')
      act(() => {
        result.current.updateShot(2, (shot) => withBody(shot, '需要保留的草稿'))
      })

      expect(await saveDraft(result)).toBe(false)
      expect(result.current.state).toMatchObject({ kind: 'error', message: expect.any(String) })
      expect(result.current.document).toEqual(expected)
      expect(result.current.hasUnsavedChanges).toBe(true)
      expect(workspace.read()).toEqual({ document: initial, version: 1 })
      expect(workspace.writes).toHaveLength(1)

      expect(await saveDraft(result)).toBe(true)

      expect(workspace.writes.map((write) => write.expectedVersion)).toEqual([1, 1])
      expect(workspace.writes[1]).toEqual(workspace.writes[0])
      expect(workspace.read()).toEqual({ document: expected, version: 2 })
      expect(result.current.state.kind).toBe('saved')
      expect(result.current.hasUnsavedChanges).toBe(false)
    },
  )
})
