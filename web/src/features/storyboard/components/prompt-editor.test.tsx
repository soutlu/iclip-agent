import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { parsePromptDoc, serializeLines } from '../prompt-doc'
import { PromptEditor } from './prompt-editor'
import { docToLines, linesToDoc } from './prompt-editor-doc'

const FIXTURES = [
  '她走向镜头 @Image1，脚步放慢。',
  '@Image1 开场\n收尾 @Image2',
  '第一行\n\n第三行 @Image3 尾巴',
  '',
  '只有文字，没有帧',
]

describe('linesToDoc / docToLines', () => {
  it.each(FIXTURES)('%j 经文档一趟回来逐字相同', (text) => {
    const lines = parsePromptDoc(text).sections[0]?.lines ?? []
    expect(serializeLines(docToLines(linesToDoc(lines)))).toBe(text)
  })
})

describe('PromptEditor', () => {
  const lines = parsePromptDoc('她走向镜头 @Image1，停下 @Image2。').sections[0]?.lines ?? []
  const frames = ['data:image/svg+xml,a', 'data:image/svg+xml,b']

  it('帧记号画成带缩略图的芯片，点一颗就报编号', async () => {
    const onPickFrame = vi.fn()
    await renderWithProviders(
      <PromptEditor
        aria-label="镜头 1 的描述"
        frames={frames}
        highlighted={1}
        lines={lines}
        onPickFrame={onPickFrame}
      />,
    )

    const editor = screen.getByRole('textbox', { name: '镜头 1 的描述' })
    expect(editor).toHaveTextContent('她走向镜头 @1，停下 @2。')
    const chips = screen.getAllByRole('button', { name: /看第 \d 帧/ })
    expect(chips).toHaveLength(2)
    const second = chips[1]
    expect(second?.querySelector('img')).toHaveAttribute('src', frames[1])

    // 直接触发 click，避免 ProseMirror 指针选区依赖 jsdom 不具备的布局几何。
    if (second !== undefined) fireEvent.click(second)
    expect(onPickFrame).toHaveBeenCalledWith(2)
  })

  it('只读态不可编辑', async () => {
    await renderWithProviders(
      <PromptEditor aria-label="只读" frames={frames} lines={lines} readOnly />,
    )
    expect(screen.getByRole('textbox', { name: '只读' })).toHaveAttribute(
      'contenteditable',
      'false',
    )
  })

  it.each(['{Enter}', ' '])('帧芯片能通过键盘 %s 激活', async (key) => {
    let selectedFrame: number | undefined
    await renderWithProviders(
      <PromptEditor
        aria-label="镜头 1 的描述"
        frames={frames}
        lines={lines}
        onPickFrame={(number) => {
          selectedFrame = number
        }}
      />,
    )
    const chip = screen.getByRole('button', { name: '看第 2 帧' })
    expect(chip).toHaveAttribute('tabindex', '0')
    chip.focus()
    await userEvent.keyboard(key)

    expect(selectedFrame).toBe(2)
    expect(screen.getByRole('textbox', { name: '镜头 1 的描述' })).toHaveTextContent(
      '她走向镜头 @1，停下 @2。',
    )
  })
})
