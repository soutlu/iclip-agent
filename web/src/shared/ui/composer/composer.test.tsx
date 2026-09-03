/**
 * 输入卡：PM 编辑区的键盘与发送门槛、附件 pill 的粘贴/拖入/删除、拖放遮罩。
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import {
  dropFilesIntoWindow,
  pasteFilesIntoComposer,
  pasteTextIntoComposer,
} from '@/testing/editor'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { Composer } from './composer'

const editor = () => screen.getByLabelText('输入消息')
const sendButton = () => screen.getByRole('button', { name: '发送' })
const imageFile = (name = '截图.png') => new File(['fake-png-bytes'], name, { type: 'image/png' })

describe('Composer', () => {
  it('空输入时发送禁用，粘入文字后放开，Enter 触发提交', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    expect(sendButton()).toBeDisabled()

    pasteTextIntoComposer(editor(), '做一个产品宣传片')
    expect(sendButton()).toBeEnabled()

    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({
      media: [],
      parts: [{ kind: 'text', text: '做一个产品宣传片' }],
      text: '做一个产品宣传片',
    })
  })

  it('IME 组字期间的 Enter 是选字，不触发提交', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    pasteTextIntoComposer(editor(), '正在输入')
    fireEvent.keyDown(editor(), { isComposing: true, key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Shift+Enter 换行不提交', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    pasteTextIntoComposer(editor(), '第一行')
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(editor().textContent).toContain('\n')
  })

  it('粘贴图片落成内联 pill，传完才能发，发送带上公网地址', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])

    // pill 立刻落进文档，但还在传：发送被挡（照 kimi 的 blocked 语义）
    expect(screen.getByText('截图.png')).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()

    // 上传管线（签名 → 直传 → 登记）走完才放开；只有附件没有字也能发
    await waitFor(() => expect(sendButton()).toBeEnabled())
    await user.click(sendButton())

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submission = onSubmit.mock.calls[0]?.[0] as {
      media: { kind: string; url: string }[]
      text: string
    }
    expect(submission.text).toBe('')
    expect(submission.media).toHaveLength(1)
    expect(submission.media[0]?.kind).toBe('image')
    expect(submission.media[0]?.url).toContain('/mock-oss/')
  })

  it('上传失败：pill 留着，发送一直被挡', async () => {
    const onSubmit = vi.fn()
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '不收 image/png 这个类型' }, { status: 422 }),
      ),
    )
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])

    await waitFor(() => expect(screen.getByText('截图.png')).toBeInTheDocument())
    // 给失败落定一拍；pill 引着一颗失败附件，发送始终禁用
    await waitFor(() => expect(sendButton()).toBeDisabled())
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('退格删掉 pill 之后发送重新禁用（entry 随文档回收）', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])
    await waitFor(() => expect(sendButton()).toBeEnabled())

    // 光标紧跟 pill 时一下退格整颗删（PM captureKeyDown 的 stopNativeHorizontalDelete）
    fireEvent.keyDown(editor(), { key: 'Backspace', keyCode: 8 })

    await waitFor(() => expect(screen.queryByText('截图.png')).not.toBeInTheDocument())
    expect(sendButton()).toBeDisabled()
  })

  it('拖文件进窗口：先出全屏遮罩，松手落成 pill、遮罩消失', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    const file = imageFile()
    const dataTransfer = {
      files: [file],
      items: [{ kind: 'file', type: file.type, webkitGetAsEntry: () => null }],
      types: ['Files'],
    }
    fireEvent.dragEnter(window, { dataTransfer })
    expect(screen.getByText('松开鼠标添加附件')).toBeInTheDocument()

    fireEvent.drop(window, { dataTransfer })
    expect(screen.queryByText('松开鼠标添加附件')).not.toBeInTheDocument()
    expect(screen.getByText('截图.png')).toBeInTheDocument()
    await waitFor(() => expect(sendButton()).toBeEnabled())
  })

  it('attachmentsEnabled 未给时：没有附件入口，拖入也不出遮罩', async () => {
    const onSubmit = vi.fn()
    await renderWithProviders(<Composer onSubmit={onSubmit} />)

    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument()
    expect(screen.queryByText('松开鼠标添加附件')).not.toBeInTheDocument()

    dropFilesIntoWindow([imageFile()])
    expect(screen.queryByText('截图.png')).not.toBeInTheDocument()
  })

  it('上传中不允许提交（Enter 与按钮都挡）', async () => {
    const onSubmit = vi.fn()
    server.use(
      http.post('*/api/uploads/sign', async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    await renderWithProviders(<Composer attachmentsEnabled onSubmit={onSubmit} />)

    pasteFilesIntoComposer(editor(), [imageFile()])
    expect(await screen.findByText('截图.png')).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()

    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
