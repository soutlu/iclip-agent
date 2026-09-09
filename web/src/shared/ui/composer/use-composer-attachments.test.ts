import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { useComposerAttachments } from './use-composer-attachments'

const imageFile = (name = '截图.png', type = 'image/png') => new File(['fake'], name, { type })

const mint = (result: { current: ReturnType<typeof useComposerAttachments> }, file: File) => {
  let attId = ''
  act(() => {
    attId = result.current.mintEntry(file).attId
  })
  return attId
}

describe('useComposerAttachments', () => {
  afterEach(() => {
    // 撤销测试添加到全局 URL 的方法，避免污染其他用例。
    delete (URL as unknown as Record<string, unknown>)['createObjectURL']
    delete (URL as unknown as Record<string, unknown>)['revokeObjectURL']
  })

  it('走完上传管线：uploading → ready，地址来自登记回包', async () => {
    const { result } = renderHook(() => useComposerAttachments())

    const attId = mint(result, imageFile())
    expect(result.current.entries.get(attId)?.status).toBe('uploading')

    await waitFor(() => expect(result.current.entries.get(attId)?.status).toBe('ready'))
    const entry = result.current.entries.get(attId)
    expect(entry?.url).toContain('/mock-oss/')
    expect(entry?.progress).toBeUndefined()
    expect(entry?.previewUrl).toBe(entry?.url)
  })

  it('签名被拒：error 态，文案带服务端原文', async () => {
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '不收 image/gif 这个类型，只收：image/jpeg' }, { status: 422 }),
      ),
    )
    const { result } = renderHook(() => useComposerAttachments())

    const attId = mint(result, imageFile('动图.gif', 'image/gif'))

    await waitFor(() => expect(result.current.entries.get(attId)?.status).toBe('error'))
    expect(result.current.entries.get(attId)?.error).toContain('不收 image/gif 这个类型')
  })

  it('syncReferences 回收文档不再引用的 entry；回来晚的上传结果直接丢弃', async () => {
    const { result } = renderHook(() => useComposerAttachments())

    const kept = mint(result, imageFile('留下.png'))
    const dropped = mint(result, imageFile('删掉.png'))
    act(() => result.current.syncReferences([kept]))

    expect(result.current.entries.has(dropped)).toBe(false)
    expect(result.current.entries.has(kept)).toBe(true)

    // 上传晚于删除完成时，异步回写不得恢复已回收条目。
    await waitFor(() => expect(result.current.entries.get(kept)?.status).toBe('ready'))
    expect(result.current.entries.has(dropped)).toBe(false)
  })

  it('本地预览在回收时 revoke（blob 才收，公网地址不动）', async () => {
    let nextBlob = 0
    URL.createObjectURL = vi.fn(() => `blob:mock-${(nextBlob += 1)}`)
    URL.revokeObjectURL = vi.fn()

    const { result } = renderHook(() => useComposerAttachments())
    const attId = mint(result, imageFile())
    expect(result.current.entries.get(attId)?.previewUrl).toBe('blob:mock-1')

    act(() => result.current.syncReferences([]))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('takeReady 按文档序只取就绪的；restoreEntries 把快照还回来', async () => {
    const { result } = renderHook(() => useComposerAttachments())

    const first = mint(result, imageFile('一.png'))
    const second = mint(result, imageFile('二.png'))
    await waitFor(() => expect(result.current.entries.get(second)?.status).toBe('ready'))
    expect(result.current.entries.get(first)?.status).toBe('ready')

    // 文档顺序与条目创建顺序相反，验证输出使用文档顺序。
    const ready = result.current.takeReady([second, first])
    expect(ready.map((entry) => entry.name)).toEqual(['二.png', '一.png'])

    act(() => result.current.syncReferences([]))
    expect(result.current.entries.size).toBe(0)
    act(() => result.current.restoreEntries(ready))
    expect(result.current.entries.size).toBe(2)
    expect(result.current.entries.get(first)?.status).toBe('ready')
  })
})
