import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Shot } from '../shots'
import { DEFAULT_VIDEO_OPTIONS } from '../video-generation-options'
import { ShotPage } from './shot-page'

const shot: Shot = {
  imageUrls: ['a.png', 'b.png', 'c.png'],
  index: 2,
  prompt: [
    '参考锁定：服装跟住 @Image1。',
    '',
    '[0–4秒｜镜头1]',
    '她从长椅间走向镜头 @Image1。',
    '',
    '[4–11秒｜镜头2]',
    '停下微笑 @Image2，再低头看一眼包 @Image3。',
  ].join('\n'),
  seconds: 11,
}

const renderPage = (
  frameNumber = 1,
  onPickFrame = vi.fn(),
  onChangeShot = vi.fn(),
  onGenerateVideo = vi.fn(),
) => {
  render(
    <ShotPage
      aspectRatio="9:16"
      candidates={[{ label: 'S9-1', url: 'z.png' }]}
      frameNumber={frameNumber}
      generateDisabled={false}
      generating={false}
      onChangeShot={onChangeShot}
      onChangeVideoOptions={vi.fn()}
      onGenerateVideo={onGenerateVideo}
      onOpenAllShots={vi.fn()}
      onPickFrame={onPickFrame}
      onReplaceFrame={vi.fn()}
      onUploadFrame={() => Promise.resolve('uploaded.png')}
      shot={shot}
      videoOptions={DEFAULT_VIDEO_OPTIONS}
    />,
  )
  return { onChangeShot, onGenerateVideo, onPickFrame }
}

describe('ShotPage 出片入口', () => {
  it('出片按钮旁写明提交范围是整组：镜头条数与组时长', () => {
    renderPage(1)

    expect(screen.getByText('整组 2 镜头 · 11s')).toBeVisible()
  })
})

describe('ShotPage 帧操作', () => {
  it('左右箭头切帧，到头了按不动', async () => {
    const { onPickFrame } = renderPage(1)

    expect(screen.getByRole('button', { name: '上一帧' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))

    expect(onPickFrame).toHaveBeenCalledWith(2)
  })

  it('加一帧：插在当前帧后面，记号追加到当前镜头末尾', async () => {
    const { onChangeShot, onPickFrame } = renderPage(1)
    await userEvent.click(screen.getByRole('button', { name: '加一帧' }))
    await userEvent.click(screen.getByRole('button', { name: '选 S9-1' }))

    const next = onChangeShot.mock.calls[0]?.[0] as Shot
    expect(next.imageUrls).toEqual(['a.png', 'z.png', 'b.png', 'c.png'])
    expect(next.prompt).toContain('她从长椅间走向镜头 @Image1。 @Image2')
    expect(next.prompt).toContain('停下微笑 @Image3，再低头看一眼包 @Image4。')
    expect(onPickFrame).toHaveBeenCalledWith(2)
  })
})
