import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
import { PromptEditor, type PromptEditorHandle } from './prompt-editor'
import { docToPrompt, promptOffsetAt, promptToDoc } from './prompt-editor-doc'

const FIXTURES = [
  '她走向镜头 @Image1，脚步放慢。',
  '@Image1 开场\n收尾 @Image2',
  '第一行\n\n第三行 @Image3 尾巴',
  '  参考 @Image01\r\n\r\n末尾 @Image2。  \r\n',
  '[0–2秒｜镜头9]\n正文里的时间线样式文本\n',
  '前😀@Image01后\n\n尾@Image2',
  '',
  '只有文字，没有帧',
]

describe('promptToDoc / docToPrompt', () => {
  it.each(FIXTURES)('%j 往返保留原始字符串', (text) => {
    expect(docToPrompt(promptToDoc(text))).toBe(text)
  })

  it('选区偏移按 UTF-16 原文计算，包含完整帧标记、空行和表情', () => {
    const text = '前😀@Image01后\n\n尾@Image2'
    const doc = promptToDoc(text)
    expect(
      [1, 4, 5, 6, 8, 10, doc.content.size].map((position) => promptOffsetAt(doc, position)),
    ).toEqual([0, 3, 11, 12, 13, 14, text.length])
  })
})

describe('PromptEditor', () => {
  const value = '她走向镜头 @Image1，停下 @Image2。'
  const frames = ['data:image/svg+xml,a', 'data:image/svg+xml,b']

  it('帧标记带缩略图，点击时返回本组图片编号', async () => {
    let selected: number | undefined
    await renderWithProviders(
      <PromptEditor
        aria-label="镜头 1 的描述"
        frames={frames}
        highlighted={1}
        onPickFrame={(number) => {
          selected = number
        }}
        value={value}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '镜头 1 的描述' })
    expect(editor).toHaveTextContent('她走向镜头 @1，停下 @2。')
    const chip = screen.getByRole('button', { name: '看第 2 帧' })
    expect(chip.querySelector('img')).toHaveAttribute('src', frames[1])
    fireEvent.click(chip)
    expect(selected).toBe(2)
  })

  it('正文普通编辑与撤销不会改写已有标记、空白或换行', async () => {
    const original = '  前言 @Image01。\n\n收尾 @Image2。\n'
    let changed = original
    const ref = createRef<PromptEditorHandle>()
    await renderWithProviders(
      <PromptEditor
        aria-label="正文"
        frames={frames}
        onChange={(next) => {
          changed = next
        }}
        ref={ref}
        value={original}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '正文' })
    editor.focus()
    pasteTextIntoComposer(editor, '新增')
    expect(changed).toBe(`新增${original}`)
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(changed).toBe(original)
    await userEvent.keyboard('{Control>}a{/Control}')
    expect(ref.current?.getInsertion()).toEqual({ text: original, start: 0, end: original.length })
  })

  it('多行粘贴保留原始帧标记并可继续选择该帧', async () => {
    const pasted = '  新内容 @Image02\n\n最后一行 @Image1。  '
    let changed = value
    await renderWithProviders(
      <PromptEditor
        aria-label="正文"
        frames={frames}
        onChange={(next) => {
          changed = next
        }}
        value={value}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '正文' })
    editor.focus()
    await userEvent.keyboard('{Control>}a{/Control}')
    pasteTextIntoComposer(editor, pasted)
    expect(changed).toBe(pasted)
    expect(screen.getByRole('button', { name: '看第 2 帧' })).toBeVisible()
  })

  it('无图或越界引用不创建带无效地址的图片', async () => {
    await renderWithProviders(
      <PromptEditor aria-label="正文" frames={[]} value="待修正 @Image4。" />,
    )
    const chip = screen.getByRole('button', { name: '看第 4 帧' })
    expect(chip.querySelector('img')).not.toHaveAttribute('src')
  })

  it('只读态不可编辑', async () => {
    await renderWithProviders(
      <PromptEditor aria-label="只读" frames={frames} readOnly value={value} />,
    )
    expect(screen.getByRole('textbox', { name: '只读' })).toHaveAttribute(
      'contenteditable',
      'false',
    )
  })

  it.each(['{Enter}', ' '])('帧标记可通过键盘 %s 激活', async (key) => {
    let selected: number | undefined
    await renderWithProviders(
      <PromptEditor
        aria-label="正文"
        frames={frames}
        onPickFrame={(number) => {
          selected = number
        }}
        value={value}
      />,
    )
    const chip = screen.getByRole('button', { name: '看第 2 帧' })
    chip.focus()
    await userEvent.keyboard(key)
    expect(selected).toBe(2)
  })
})
