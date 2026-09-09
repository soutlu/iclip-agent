import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { TaskMediaField } from './task-media-field'

describe('TaskMediaField', () => {
  const assetId = 'f40a7a4b-90ec-438b-8bf0-9bde53a290fc'
  const uploadUrl = `http://localhost/mock-oss/${assetId}`
  const assetUrl = 'https://assets.example.com/uploaded.png'
  const oldUrl = 'https://assets.example.com/old.png'
  const changes: string[][] = []
  const busy: boolean[] = []
  const imageFile = (name = '商品.png') => new File(['image'], name, { type: 'image/png' })
  const envelope = () =>
    HttpResponse.json({
      asset: {
        assetType: 'image',
        contentType: 'image/png',
        createdAt: '2026-09-06T10:00:00Z',
        creatorUserId: '427f8cd9-8016-4f54-a581-812447e97fdc',
        id: assetId,
        sizeBytes: 5,
        url: assetUrl,
      },
    })

  beforeEach(() => {
    changes.length = 0
    busy.length = 0
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ close: vi.fn(), height: 1200, width: 800 }),
    )
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({
          assetId,
          upload: {
            expiresAt: '2026-09-06T12:00:00Z',
            headers: { 'Content-Type': 'image/png' },
            url: uploadUrl,
          },
        }),
      ),
      http.put(uploadUrl, () => new HttpResponse(null, { status: 200 })),
      http.post('*/api/assets/:assetId', envelope),
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it('批量添加保留成功图片，错误留在字段中并恢复可操作状态', async () => {
    const user = userEvent.setup({ applyAccept: false })
    await renderWithProviders(
      <TaskMediaField
        kind="image"
        label="商品图片"
        onChange={(urls) => changes.push(urls)}
        onUploadingChange={(next) => busy.push(next)}
        value={[oldUrl]}
      />,
    )

    await user.upload(screen.getByLabelText('选择商品图片文件'), [
      imageFile(),
      new File(['invalid'], '错误.txt', { type: 'text/plain' }),
    ])

    expect(await screen.findByRole('alert')).toHaveTextContent('错误.txt')
    expect(changes).toEqual([[oldUrl, assetUrl]])
    expect(busy).toEqual([true, false])
    expect(screen.getByRole('button', { name: '添加商品图片' })).toBeEnabled()
    expect(screen.getByLabelText('选择商品图片文件')).toHaveValue('')
  })

  it('拖放单个视频替换当前引用，失败时保留原引用', async () => {
    await renderWithProviders(
      <TaskMediaField
        kind="video"
        label="参考视频"
        onChange={(urls) => changes.push(urls)}
        value={[oldUrl]}
      />,
    )
    const video = new File(['video'], '参考.mp4', { type: 'video/mp4' })
    fireEvent.drop(screen.getByRole('group', { name: '参考视频' }), {
      dataTransfer: { files: [video], items: [], types: ['Files'] },
    })
    await waitFor(() => expect(changes).toEqual([[assetUrl]]))

    server.use(
      http.post('*/api/assets/:assetId', () =>
        HttpResponse.json({ detail: '视频登记失败' }, { status: 422 }),
      ),
    )
    fireEvent.drop(screen.getByRole('group', { name: '参考视频' }), {
      dataTransfer: { files: [video], items: [], types: ['Files'] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('视频登记失败')
    expect(changes).toEqual([[assetUrl]])
    expect(screen.getByRole('button', { name: '预览参考视频 1' })).toBeVisible()
  })

  it('视频可打开真实播放器，媒体移除按钮支持键盘操作', async () => {
    const user = userEvent.setup()
    const videoUrl = 'https://assets.example.com/reference.mp4'
    await renderWithProviders(
      <TaskMediaField
        kind="video"
        label="参考视频"
        onChange={(urls) => changes.push(urls)}
        value={[videoUrl]}
      />,
    )

    expect(screen.getByRole('button', { name: '替换参考视频' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '预览参考视频 1' }))
    expect(screen.getByRole('dialog', { name: '参考视频 1' })).toBeVisible()
    const player = screen.getByLabelText('参考视频 1', { selector: 'video' })
    expect(player).toHaveAttribute('src', videoUrl)
    expect(player).toHaveAttribute('controls')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '参考视频 1' })).not.toBeInTheDocument()

    screen.getByRole('button', { name: '移除参考视频 1' }).focus()
    await user.keyboard('{Enter}')
    expect(changes).toEqual([[]])
  })

  it('超过剩余容量时不上传，也不会截断用户选择', async () => {
    const user = userEvent.setup()
    await renderWithProviders(
      <TaskMediaField
        kind="image"
        label="模特参考图"
        maxFiles={2}
        onChange={(urls) => changes.push(urls)}
        value={[oldUrl]}
      />,
    )
    await user.upload(screen.getByLabelText('选择模特参考图文件'), [
      imageFile('一.png'),
      imageFile('二.png'),
    ])
    expect(screen.getByRole('alert')).toHaveTextContent('还可添加 1 张')
    expect(changes).toEqual([])
  })

  it('关闭表单后丢弃正在上传的结果，并释放父表单的上传状态', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let registering = false
    server.use(
      http.post('*/api/assets/:assetId', async () => {
        registering = true
        await pending
        return envelope()
      }),
    )
    const { unmount } = await renderWithProviders(
      <TaskMediaField
        kind="image"
        label="商品图片"
        onChange={(urls) => changes.push(urls)}
        onUploadingChange={(next) => busy.push(next)}
        value={[]}
      />,
    )
    await user.upload(screen.getByLabelText('选择商品图片文件'), imageFile())
    await waitFor(() => expect(registering).toBe(true))
    expect(screen.getByRole('button', { name: '添加商品图片' })).toBeDisabled()
    unmount()
    await act(async () => {
      release?.()
      await pending
    })
    expect(changes).toEqual([])
    expect(busy).toEqual([true, false])
  })
})
