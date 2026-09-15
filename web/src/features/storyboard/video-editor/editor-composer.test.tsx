import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { renderWithProviders } from '@/testing/render'
import { EditorComposer, type EditorReference } from './editor-composer'

function Composer() {
  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<EditorReference[]>([])
  return (
    <>
      <EditorComposer
        onPromptChange={setPrompt}
        onReferencesChange={setReferences}
        prompt={prompt}
        references={references}
      />
      <Toaster />
    </>
  )
}

const imageFile = (name = '背景.png') => new File(['image'], name, { type: 'image/png' })

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
})

afterEach(() => {
  toast.dismiss()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('视频编辑参考输入', () => {
  it('文字与多张本地图片共用输入区，可以预览并移除图片', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Composer />)
    await user.type(screen.getByRole('textbox', { name: '修改要求' }), '保留鞋款，调整背景')
    await user.upload(screen.getByLabelText('选择参考图片'), [imageFile(), imageFile('鞋款.png')])

    const strip = screen.getByRole('group', { name: '参考图片' })
    expect(await within(strip).findByRole('img', { name: '背景.png' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/png;base64,/),
    )
    expect(within(strip).getByRole('img', { name: '鞋款.png' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '修改要求' })).toHaveValue('保留鞋款，调整背景')
    const preview = within(strip).getByRole('button', { name: '预览参考图 背景.png' })
    await user.click(preview)
    expect(await screen.findByRole('dialog', { name: '背景.png' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(preview).toHaveFocus())
    await user.click(within(strip).getByRole('button', { name: '移除参考图 背景.png' }))
    expect(within(strip).queryByRole('img', { name: '背景.png' })).not.toBeInTheDocument()
    expect(within(strip).getByRole('img', { name: '鞋款.png' })).toBeVisible()
  })

  it('拖入图片与粘贴图片会添加参考，纯文本粘贴仍写入要求', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Composer />)
    const input = screen.getByRole('textbox', { name: '修改要求' })
    fireEvent.drop(input, { dataTransfer: { files: [imageFile()], types: ['Files'] } })
    expect(await screen.findByRole('img', { name: '背景.png' })).toBeVisible()

    const paste = createEvent.paste(input, {
      clipboardData: { files: [imageFile('光线.png')], types: ['Files'] },
    })
    fireEvent(input, paste)
    expect(paste.defaultPrevented).toBe(true)
    expect(await screen.findByRole('img', { name: '光线.png' })).toBeVisible()
    await user.click(input)
    await user.paste('柔和的自然光')
    expect(input).toHaveValue('柔和的自然光')
  })

  it.each([
    { file: new File(['x'], '脚本.svg', { type: 'image/svg+xml' }), message: /请选择 PNG/ },
    {
      file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], '大图.png', { type: 'image/png' }),
      message: /不能超过 10 MB/,
    },
    { file: new File([], '空图.png', { type: 'image/png' }), message: /图片文件为空/ },
  ])('拒绝不支持、超限或空图片：$file.name', async ({ file, message }) => {
    await renderWithProviders(<Composer />)
    fireEvent.change(screen.getByLabelText('选择参考图片'), { target: { files: [file] } })
    expect(await screen.findByText(message)).toBeVisible()
    expect(
      within(screen.getByRole('group', { name: '参考图片' })).queryByRole('img'),
    ).not.toBeInTheDocument()
  })

  it('读取失败显示错误，允许重新选择文件', async () => {
    const user = userEvent.setup()
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementationOnce(function (
      this: FileReader,
    ) {
      this.dispatchEvent(new ProgressEvent('error'))
    })
    await renderWithProviders(<Composer />)
    const input = screen.getByLabelText('选择参考图片')
    await user.upload(input, imageFile())
    expect(await screen.findByText('参考图片读取失败，请重新选择')).toBeVisible()
    expect(screen.getByRole('button', { name: '添加参考图片' })).toBeEnabled()
    await user.upload(input, imageFile())
    expect(await screen.findByRole('img', { name: '背景.png' })).toBeVisible()
  })
})
