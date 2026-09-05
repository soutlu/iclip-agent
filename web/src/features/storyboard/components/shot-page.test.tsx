import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Shot } from '../shots'
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
      onGenerateVideo={onGenerateVideo}
      onOpenAllShots={vi.fn()}
      onPickFrame={onPickFrame}
      onUploadFrame={() => Promise.resolve('uploaded.png')}
      shot={shot}
    />,
  )
  return { onChangeShot, onGenerateVideo, onPickFrame }
}

describe('ShotPage 帧操作', () => {
  it('左右箭头切帧，到头了按不动', async () => {
    const { onPickFrame } = renderPage(1)

    expect(screen.getByRole('button', { name: '上一帧' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))

    expect(onPickFrame).toHaveBeenCalledWith(2)
  })

  it('右移当前帧：两张对调，编号同步', async () => {
    const { onChangeShot, onPickFrame } = renderPage(2)
    await userEvent.click(screen.getByRole('button', { name: '更多帧操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '右移这一帧' }))

    const next = onChangeShot.mock.calls[0]?.[0] as Shot
    expect(next.imageUrls).toEqual(['a.png', 'c.png', 'b.png'])
    expect(next.prompt).toContain('停下微笑 @Image3，再低头看一眼包 @Image2。')
    expect(onPickFrame).toHaveBeenCalledWith(3)
  })

  it('替换：从候选里挑一张，只换地址不动描述', async () => {
    const { onChangeShot } = renderPage(1)
    await userEvent.click(screen.getByRole('button', { name: '替换这一帧' }))
    await userEvent.click(screen.getByRole('button', { name: '选 S9-1' }))

    const next = onChangeShot.mock.calls[0]?.[0] as Shot
    expect(next.imageUrls).toEqual(['z.png', 'b.png', 'c.png'])
    expect(next.prompt).toBe(shot.prompt)
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
