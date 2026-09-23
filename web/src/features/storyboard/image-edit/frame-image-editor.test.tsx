import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { FrameImageEditor } from './frame-image-editor'
import { editDraftKey } from './image-edit-draft'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
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
const job = (over: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({
    metadata: { frame: 1, shot: 1, sourceUrl: BASE },
    kind: 'image',
    status: 'pending',
    createdAt: '2026-09-07T12:00:00Z',
    request: { prompt: '将衣服改成蓝色', referenceImageUrls: [BASE] },
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

const UPLOADED = 'https://example.com/uploaded.png'
const imageFile = () => new File(['image'], '参考.png', { type: 'image/png' })

/** 卡在确认那一步的参考图上传；调用返回的开关才放行。 */
function stallUpload() {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  server.use(
    http.post('*/api/uploads/:uploadId/confirm', async () => {
      await held
      return HttpResponse.json({ contentType: 'image/png', sizeBytes: 5, url: UPLOADED })
    }),
  )
  return () => release()
}

/** jsdom 不加载图片也不排版：给底图固有尺寸、给画布外框，返回可以落笔的画布。 */
function loadCanvas(editor: HTMLElement) {
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      readonly pointerId = 1
    },
  )
  const image = within(editor).getByRole('img', { name: '当前编辑帧' })
  Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 800 } })
  fireEvent.load(image)
  const canvas = within(editor).getByRole('group', { name: '图片标注画布' })
  Object.assign(canvas, {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  return canvas
}

/** 在画布中央点一个点标注。 */
function drawPoint(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400, button: 0 })
  fireEvent.pointerUp(canvas, { clientX: 400, clientY: 400, button: 0 })
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
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ close: vi.fn(), height: 1200, width: 800 }),
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

  it('生成设置里可以切换渠道，换成没有渠道轴的模型后提交不再携带渠道', async () => {
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: job() }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage />)

    const models = await screen.findByLabelText('图片模型')
    const generate = screen.getByRole('button', { name: '生成图片' })
    expect(screen.queryByRole('menuitemradio', { name: 'pro' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: '更多生成设置' }))
    const channels = await screen.findByRole('group', { name: '图片生成渠道' })
    expect(within(channels).getByRole('menuitemradio', { name: 'dev' })).toBeChecked()
    await userEvent.click(within(channels).getByRole('menuitemradio', { name: 'pro' }))
    await userEvent.click(generate)
    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]?.['channel']).toBe('pro')

    await waitFor(() => expect(models).toBeEnabled())
    await userEvent.selectOptions(models, 'seedream_v5_pro')

    expect(screen.queryByRole('button', { name: '更多生成设置' })).not.toBeInTheDocument()
    const resolutions = within(screen.getByLabelText('图片分辨率')).getAllByRole('option')
    expect(resolutions.map((option) => option.textContent)).toEqual(['1K', '2K'])

    await userEvent.click(generate)
    await waitFor(() => expect(submissions).toHaveLength(2))
    expect(submissions[1]?.['model']).toBe('seedream_v5_pro')
    expect(submissions[1]?.['channel']).toBeUndefined()
    expect(submissions[1]?.['metadata']).toMatchObject({ sourceUrl: BASE })
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

    await userEvent.click(within(editor).getByRole('button', { name: '生成图片' }))

    expect(await screen.findByText('编辑草稿无法暂存，关闭页面前请先提交生成')).toBeVisible()
    const queued = await within(strip).findByRole('button', { name: /^排队中 · / })
    expect(queued).toHaveAttribute('aria-pressed', 'true')
    expect(await within(editor).findByRole('status')).toBeVisible()
    expect(await within(editor).findByText(/记录刷新失败/)).toBeVisible()
    expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
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
    // 折进当前帧格之后不再是一张「还没应用」的结果。
    expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
    expect(within(strip).queryByRole('button', { name: /^结果 · / })).not.toBeInTheDocument()
    // 被换下来的那张留在条里，选中它就能换回去。
    const previous = within(strip).getByRole('button', { name: /^上一版 · / })
    await userEvent.click(previous)
    expect(within(editor).getByRole('button', { name: '应用到当前帧' })).toBeEnabled()
  })

  it.each(['pending', 'submitted'] as const)('任务处于 %s 时仍能提交新的编辑', async (status) => {
    const existing = job({ status })
    const submitted = job({ createdAt: '2026-09-07T12:01:00Z' })
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.get('*/api/generations', () =>
        HttpResponse.json({ items: submissions.length === 0 ? [existing] : [submitted, existing] }),
      ),
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: submitted }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage initialKey={existing.id} />)

    const editor = await screen.findByRole('dialog')
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    const selected = await within(strip).findByRole('button', { name: /^(排队中|生成中) · / })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(within(editor).getByRole('status')).toBeVisible()
    expect(within(editor).getByRole('img', { name: '本次编辑底图' })).toHaveAttribute('src', BASE)
    expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
    const generate = within(editor).getByRole('button', { name: '生成图片' })
    await waitFor(() => expect(generate).toBeEnabled())

    await userEvent.click(generate)

    await waitFor(() => expect(submissions).toHaveLength(1))
    await waitFor(() =>
      expect(within(strip).getAllByRole('button', { name: /^(排队中|生成中) · / })).toHaveLength(2),
    )
    expect(selected).toHaveAttribute('aria-pressed', 'false')
    const next = within(strip)
      .getAllByRole('button', { name: /^排队中 · / })
      .find((button) => button !== selected)
    expect(next).toHaveAttribute('aria-pressed', 'true')
  })

  it.each(['图像服务拒绝了请求（400）: {"detail":"invalid reference image"}', null])(
    '失败状态按需展开原始错误，不把详情直接铺在预览区：%s',
    async (errorMessage) => {
      const failed = job({ status: 'failed', errorMessage })
      server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [failed] })))
      await renderWithProviders(<EditorPage initialKey={failed.id} />)

      const editor = await screen.findByRole('dialog')
      const alert = await within(editor).findByRole('alert')
      expect(alert).toBeVisible()
      expect(within(editor).getByRole('img', { name: '本次编辑底图' })).toHaveAttribute('src', BASE)
      expect(within(editor).queryByRole('button', { name: '应用到当前帧' })).not.toBeInTheDocument()
      if (errorMessage === null) {
        expect(within(editor).queryByText('查看详情')).not.toBeInTheDocument()
      } else {
        const error = within(editor).getByText(errorMessage)
        expect(error).not.toBeVisible()
        await userEvent.click(within(editor).getByText('查看详情'))
        expect(error).toBeVisible()
        await userEvent.click(within(editor).getByText('查看详情'))
        expect(error).not.toBeVisible()
      }
      await userEvent.click(within(editor).getByRole('button', { name: '返回当前帧' }))
      const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
      expect(within(strip).getByRole('button', { name: '当前帧' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    },
  )

  it('参考图上传期间换不了底图，传完的图落在发起上传的那张底图的草稿里', async () => {
    const completed = job({ status: 'completed', outputUrl: RESULT })
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })))
    const release = stallUpload()
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    const result = await within(strip).findByRole('button', { name: /^结果 · / })

    await userEvent.upload(within(editor).getByLabelText('上传参考图片'), imageFile())
    await waitFor(() => expect(result).toBeDisabled())
    await userEvent.click(result)
    expect(within(strip).getByRole('button', { name: '当前帧' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    release()
    const uploaded = { name: /^引用参考图 2 · 参考\.png$/ }
    expect(await within(editor).findByRole('button', uploaded)).toBeVisible()

    // 换到结果那一格是另一张底图，它的草稿里没有刚上传的图；换回来又在。
    await userEvent.click(result)
    await waitFor(() =>
      expect(within(editor).queryByRole('button', uploaded)).not.toBeInTheDocument(),
    )
    await userEvent.click(within(strip).getByRole('button', { name: '当前帧' }))
    expect(within(editor).getByRole('button', uploaded)).toBeVisible()
  })

  it('上传没完时关不掉窗口，提示等待完成', async () => {
    const release = stallUpload()
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    await userEvent.upload(within(editor).getByLabelText('上传参考图片'), imageFile())

    await userEvent.click(within(editor).getByRole('button', { name: '关闭图片编辑' }))

    expect(await screen.findByText('请等待上传或保存完成')).toBeVisible()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    release()
    expect(
      await within(editor).findByRole('button', { name: /^引用参考图 2 · 参考\.png$/ }),
    ).toBeVisible()
  })

  it('参考图上传失败给出原因，图片列表不变且可以再试', async () => {
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '对象存储暂时不可用' }, { status: 503 }),
      ),
    )
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')

    await userEvent.upload(within(editor).getByLabelText('上传参考图片'), imageFile())

    expect(await screen.findByText(/对象存储暂时不可用/)).toBeVisible()
    const references = within(editor).getByRole('list', { name: '提交图片顺序' })
    expect(within(references).getAllByRole('img')).toHaveLength(1)
    expect(within(editor).getByRole('button', { name: '添加参考图片' })).toBeEnabled()
  })

  it('拖进参考图片区就地上传，事件带着 defaultPrevented 冒到 window 供聊天遮罩收尾', async () => {
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    const zone = within(editor).getByRole('list', { name: '提交图片顺序' }).parentElement
    expect(zone).not.toBeNull()

    // 聊天输入框的遮罩挂在 window 上，靠这三个事件冒泡回来才关得掉。
    const seen: { type: string; prevented: boolean }[] = []
    const record = (event: Event) =>
      seen.push({ type: event.type, prevented: event.defaultPrevented })
    for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, record)

    const file = imageFile()
    const dataTransfer = {
      dropEffect: '',
      files: [file],
      items: [{ kind: 'file', type: file.type, webkitGetAsEntry: () => null }],
      types: ['Files'],
    }
    fireEvent.dragEnter(zone as HTMLElement, { dataTransfer })
    fireEvent.dragOver(zone as HTMLElement, { dataTransfer })
    // 弹窗对文件一律标「禁止落点」，但参考图片区先接管了，它的「复制」不能被弹窗改掉。
    expect(dataTransfer.dropEffect).toBe('copy')
    fireEvent.drop(zone as HTMLElement, { dataTransfer })
    for (const type of ['dragenter', 'dragover', 'drop']) window.removeEventListener(type, record)

    expect(seen).toEqual([
      { type: 'dragenter', prevented: true },
      { type: 'dragover', prevented: true },
      { type: 'drop', prevented: true },
    ])
    expect(
      await within(editor).findByRole('button', { name: /^引用参考图 2 · 参考\.png$/ }),
    ).toBeVisible()
  })

  it('上传期间参考图片区标成禁止落点，弹窗其余位置对文件也一律禁止且不放给背后的聊天框', async () => {
    const release = stallUpload()
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    const zone = within(editor).getByRole('list', { name: '提交图片顺序' }).parentElement
    await userEvent.upload(within(editor).getByLabelText('上传参考图片'), imageFile())

    const dragTo = (target: HTMLElement) => {
      const dataTransfer = { dropEffect: '', files: [], items: [], types: ['Files'] }
      fireEvent.dragOver(target, { dataTransfer })
      const drop = createEvent.drop(target, { dataTransfer })
      fireEvent(target, drop)
      return { dropEffect: dataTransfer.dropEffect, dropPrevented: drop.defaultPrevented }
    }
    expect(dragTo(zone as HTMLElement)).toEqual({ dropEffect: 'none', dropPrevented: true })
    expect(dragTo(within(editor).getByRole('textbox', { name: '修改要求' }))).toEqual({
      dropEffect: 'none',
      dropPrevented: true,
    })
    release()
    expect(
      await within(editor).findByRole('button', { name: /^引用参考图 2 · 参考\.png$/ }),
    ).toBeVisible()
  })

  it('从历史菜单恢复输入后回到底图，再次提交保留那次的要求和参考图片', async () => {
    const references = [BASE, 'https://example.com/reference.png']
    const prompt = '保留人物，背景换成傍晚的暖光'
    const completed = job({
      status: 'completed',
      outputUrl: RESULT,
      request: { prompt, referenceImageUrls: references },
    })
    const submissions: Record<string, unknown>[] = []
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: [completed] })),
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ generation: job() }, { status: 202 })
      }),
    )
    await renderWithProviders(<EditorPage initialKey={completed.id} />)

    const editor = await screen.findByRole('dialog')
    await within(editor).findByRole('img', { name: '图片编辑结果' })
    expect(screen.queryByRole('menuitem', { name: '恢复这次的输入' })).not.toBeInTheDocument()
    await userEvent.click(within(editor).getByRole('button', { name: '图片历史操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '恢复这次的输入' }))

    const strip = within(editor).getByRole('group', { name: '这一帧的图片' })
    expect(within(strip).getByRole('button', { name: '当前帧' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(editor).getByRole('textbox', { name: '修改要求' })).toHaveTextContent(prompt)
    await userEvent.click(within(editor).getByRole('button', { name: '生成图片' }))
    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]).toMatchObject({
      prompt,
      referenceImageUrls: references,
      metadata: { sourceUrl: BASE },
    })
  })

  it('空草稿上画一个标注再撤销，重做仍可用并能画回来', async () => {
    // 撤销到空时草稿被删，之后每次渲染拿到的都是新的空数组；画布的撤销栈不能因此被清掉。
    sessionStorage.clear()
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    drawPoint(loadCanvas(editor))
    expect(within(editor).getByRole('button', { name: '标注 1' })).toBeInTheDocument()

    await userEvent.click(within(editor).getByRole('button', { name: '撤销标注' }))
    expect(within(editor).queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    const redo = within(editor).getByRole('button', { name: '重做标注' })
    expect(redo).toBeEnabled()
    await userEvent.click(redo)

    expect(within(editor).getByRole('button', { name: '标注 1' })).toBeInTheDocument()
  })

  it('草稿读坏后点重新开始，画过的标注连同撤销记录一起作废', async () => {
    sessionStorage.setItem(editDraftKey(target), JSON.stringify({ [BASE]: { annotations: 1 } }))
    await renderWithProviders(<EditorPage />)
    const editor = await screen.findByRole('dialog')
    drawPoint(loadCanvas(editor))
    expect(within(editor).getByRole('button', { name: '标注 1' })).toBeInTheDocument()

    await userEvent.click(within(editor).getByRole('button', { name: '重新开始' }))
    loadCanvas(editor)

    expect(within(editor).queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    expect(within(editor).getByRole('button', { name: '撤销标注' })).toBeDisabled()
  })
})
