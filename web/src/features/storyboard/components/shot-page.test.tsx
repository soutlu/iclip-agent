import { fireEvent, render, screen, within } from '@testing-library/react'
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
      onPickFrame={onPickFrame}
      onUploadFrame={() => Promise.resolve('uploaded.png')}
      shot={shot}
    />,
  )
  return { onChangeShot, onGenerateVideo, onPickFrame }
}

describe('ShotPage', () => {
  it('画面下写清是第几帧、属于哪个镜头', () => {
    renderPage(2)
    expect(screen.getByText('@2 · 镜头 2')).toBeVisible()
    expect(screen.getByRole('img', { name: '镜头组 2 第 2 帧' })).toBeVisible()
  })

  it('左右箭头切帧，到头了按不动', async () => {
    const { onPickFrame } = renderPage(1)

    expect(screen.getByRole('button', { name: '上一帧' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))

    expect(onPickFrame).toHaveBeenCalledWith(2)
  })

  it('描述按时间线分段，段头写镜头号与起止秒', () => {
    renderPage(1)
    expect(screen.getByText('镜头 1 · 0–4 秒')).toBeVisible()
    expect(screen.getByText('镜头 2 · 4–11 秒')).toBeVisible()
  })

  it('参考锁定折叠在顶部，默认收起', async () => {
    renderPage(1)
    const fold = screen.getByText('参考锁定与剪辑形式')
    const body = within(fold.closest('details') as HTMLElement).getByText(/服装跟住/)

    expect(body).not.toBeVisible()
    await userEvent.click(fold)
    expect(body).toBeVisible()
  })

  it('底部一行每镜一张：取该镜第一张帧，写镜头号与时长', () => {
    renderPage(1)
    const strip = screen.getByLabelText('本组镜头')

    expect(within(strip).getByText('镜头 1')).toBeVisible()
    expect(within(strip).getByText('4s')).toBeVisible()
    expect(within(strip).getByText('7s')).toBeVisible()
  })

  it('点底部缩略图切到该镜第一帧', async () => {
    const { onPickFrame } = renderPage(1)
    const strip = screen.getByLabelText('本组镜头')

    await userEvent.click(within(strip).getAllByRole('button')[1] as HTMLElement)

    expect(onPickFrame).toHaveBeenCalledWith(2)
  })

  it('删掉当前帧：地址表少一张，描述里的编号跟着前移，画面退到相邻那一帧', async () => {
    const { onChangeShot, onPickFrame } = renderPage(2)
    await userEvent.click(screen.getByRole('button', { name: '删掉这一帧' }))

    const next = onChangeShot.mock.calls[0]?.[0] as Shot
    expect(next.imageUrls).toEqual(['a.png', 'c.png'])
    expect(next.prompt).toContain('停下微笑，再低头看一眼包 @Image2。')
    expect(onPickFrame).toHaveBeenCalledWith(2)
  })

  it('右移当前帧：两张对调，编号同步', async () => {
    const { onChangeShot, onPickFrame } = renderPage(2)
    await userEvent.click(screen.getByRole('button', { name: '右移这一帧' }))

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

  it('改时长：整数落进组里', () => {
    const { onChangeShot } = renderPage(1)
    const input = screen.getByRole('spinbutton', { name: '镜头组 2 的时长（秒）' })
    // 受控输入框：值由外面给，这里直接派一次 change
    fireEvent.change(input, { target: { value: '9' } })

    const last = onChangeShot.mock.calls.at(-1)?.[0] as Shot
    expect(last.seconds).toBe(9)
  })

  it('没写帧的镜头画「无帧」且点不动', () => {
    render(
      <ShotPage
        aspectRatio="9:16"
        candidates={[]}
        frameNumber={1}
        generateDisabled={false}
        generating={false}
        onChangeShot={vi.fn()}
        onGenerateVideo={vi.fn()}
        onPickFrame={vi.fn()}
        onUploadFrame={() => Promise.resolve('')}
        shot={{
          imageUrls: ['a.png'],
          index: 1,
          prompt: ['[0–2秒｜镜头1]', '只有旁白。'].join('\n'),
          seconds: 4,
        }}
      />,
    )

    expect(screen.getByText('无帧')).toBeVisible()
    expect(within(screen.getByLabelText('本组镜头')).getByRole('button')).toBeDisabled()
  })

  it('没有时间线的旧交付整段当一段描述，不画底部那一行', () => {
    render(
      <ShotPage
        aspectRatio="9:16"
        candidates={[]}
        frameNumber={1}
        generateDisabled={false}
        generating={false}
        onChangeShot={vi.fn()}
        onGenerateVideo={vi.fn()}
        onPickFrame={vi.fn()}
        onUploadFrame={() => Promise.resolve('')}
        shot={{ imageUrls: ['a.png'], index: 1, prompt: '就是一段话 @Image1。', seconds: 4 }}
      />,
    )

    expect(screen.getAllByText(/就是一段话/).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('本组镜头')).not.toBeInTheDocument()
  })

  it('「打开原图」进灯箱', async () => {
    renderPage(1)
    await userEvent.click(screen.getByRole('button', { name: '打开原图' }))

    expect(screen.getByRole('dialog', { name: '镜头组 2 第 1 帧' })).toBeVisible()
  })
})
