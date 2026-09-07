import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import type { Shot } from '../shots'
import { GroupPromptSheet } from './group-prompt-sheet'

const shot: Shot = {
  imageUrls: ['one.png', 'two.png', 'unmentioned.png'],
  index: 2,
  prompt:
    '  产品：黑色切尔西短靴。\n人物：短发女性。场景：客厅。\n\n剪辑形式：硬切。\n[0–2秒｜镜头1]\n全景 @Image1。  \n\n[2–6秒｜镜头2]\n鞋底特写 @Image2。\n不要生成字幕，不要生成背景音乐。\n',
  seconds: 6,
}

const renderSheet = (overrides: Partial<Parameters<typeof GroupPromptSheet>[0]> = {}) => {
  const props = {
    aspectRatio: '9:16',
    generateDisabled: false,
    generating: false,
    onClose: vi.fn(),
    onGenerate: vi.fn(),
    shot,
    ...overrides,
  }
  const result = render(
    <>
      <GroupPromptSheet {...props} />
      <Toaster />
    </>,
  )
  return { ...result, props }
}

afterEach(() => {
  toast.dismiss()
  vi.restoreAllMocks()
})

describe('GroupPromptSheet', () => {
  it('保留开头设定、全部时间码、末尾约束和空白，复制与原文完全一致', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    renderSheet()

    const reading = screen.getByRole('region', { name: '镜头组原文' })
    expect(reading.textContent).toBe(shot.prompt)
    expect(reading).toHaveFocus()
    expect(screen.getByText('6 秒 · 9:16 · 3 张参考图')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '复制完整提示词' }))

    expect(writeText).toHaveBeenCalledExactlyOnceWith(shot.prompt)
    expect(await screen.findByText('已复制完整提示词')).toBeVisible()
  })

  it('按原始数组顺序显示本组全部参考图，包括正文未引用的图片', () => {
    renderSheet()

    const references = screen.getByRole('region', { name: '本组参考图' })
    const images = within(references).getAllByRole('img')
    expect(images).toHaveLength(shot.imageUrls.length)
    for (const [index, url] of shot.imageUrls.entries()) {
      expect(images[index]).toHaveAttribute('src', url)
      expect(images[index]).toHaveAccessibleName(`镜头组 2 参考图 @Image${index + 1}`)
      expect(within(references).getByText(`@Image${index + 1}`, { exact: true })).toBeVisible()
    }
  })

  it('参考图可放大，Escape 先关闭图片并归还焦点，再收起原文面板', async () => {
    const user = userEvent.setup()
    const { props } = renderSheet()
    const trigger = screen.getByRole('button', { name: '查看参考图 @Image3' })

    await user.click(trigger)

    const preview = await screen.findByRole('dialog', { name: '参考图 @Image3' })
    expect(within(preview).getByRole('img', { name: '镜头组 2 参考图 @Image3' })).toHaveAttribute(
      'src',
      'unmentioned.png',
    )
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(props.onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('剪贴板写入失败显示错误，不提示复制成功', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('剪贴板写入被拒绝'))
    renderSheet()

    await user.click(screen.getByRole('button', { name: '复制完整提示词' }))

    expect(await screen.findByText('剪贴板写入被拒绝')).toBeVisible()
    expect(screen.queryByText('已复制完整提示词')).not.toBeInTheDocument()
  })

  it('生成禁用时显示原因，仍可收起和复制原文', async () => {
    const user = userEvent.setup()
    const { props } = renderSheet({
      generateDisabled: true,
      generateNote: '描述还在保存，存好了再出片',
    })

    expect(screen.getByText('描述还在保存，存好了再出片')).toBeVisible()
    const generate = screen.getByRole('button', { name: '生成视频' })
    expect(generate).toBeDisabled()
    await user.click(generate)
    expect(props.onGenerate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '复制完整提示词' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '收起完整提示词' }))
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('没有参考图时保留原文，正常生成按钮交给父组件提交', async () => {
    const user = userEvent.setup()
    const { props } = renderSheet({ shot: { ...shot, imageUrls: [] } })

    expect(screen.getByText('本组暂无参考图')).toBeVisible()
    expect(screen.getByRole('region', { name: '镜头组原文' }).textContent).toBe(shot.prompt)
    await user.click(screen.getByRole('button', { name: '生成视频' }))
    expect(props.onGenerate).toHaveBeenCalledOnce()
  })
})
