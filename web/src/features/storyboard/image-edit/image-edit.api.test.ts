import { describe, expect, it } from 'vitest'
import { compileEditPrompt, parseEditPrompt } from './image-edit.api'
import type { FrameEditDraft } from './image-edit-types'

const draft = (): FrameEditDraft => ({
  annotations: [
    { id: 'a1', number: 1, kind: 'ellipse', points: [{ x: 0.3, y: 0.4 }] },
    { id: 'a2', number: 2, kind: 'point', points: [{ x: 0.5, y: 0.5 }] },
  ],
  instructions: [
    { kind: 'text', text: '把' },
    { kind: 'annotation', id: 'a1' },
    { kind: 'text', text: '的杯子换成红色，参考' },
    { kind: 'referenceImage', id: 'r3' },
    { kind: 'text', text: '的材质。' },
  ],
  references: [
    { id: 'r1', kind: 'image', url: 'https://cdn.test/frame.png', label: '当前原图' },
    { id: 'r2', kind: 'annotated', url: 'https://cdn.test/annotated.png', label: '当前标注图' },
    { id: 'r3', kind: 'image', url: 'https://cdn.test/jacket.png', label: 'jacket.png' },
  ],
})

describe('compileEditPrompt', () => {
  it('把芯片落成 @ 标记，编号取图片在本次提交里的位置', () => {
    expect(compileEditPrompt(draft())).toBe(
      '把@标注1的杯子换成红色，参考@图片3的材质。\n' +
        '图中的编号和圈选只表示位置，输出干净的图片，不保留标注。',
    )
  })

  it('没有标注图就不加那句收尾', () => {
    expect(
      compileEditPrompt({
        annotations: [],
        instructions: [{ kind: 'text', text: '换个背景' }],
        references: draft().references.filter((reference) => reference.kind !== 'annotated'),
      }),
    ).toBe('换个背景')
  })
})

describe('parseEditPrompt', () => {
  it('@图片N 装回芯片，收尾那句不留在正文里', () => {
    const original = draft()
    expect(parseEditPrompt(compileEditPrompt(original), original.references)).toEqual([
      { kind: 'text', text: '把@标注1的杯子换成红色，参考' },
      { kind: 'referenceImage', id: 'r3' },
      { kind: 'text', text: '的材质。' },
    ])
  })

  it('编号超出图片张数就当普通文字留着，不造出指向空处的芯片', () => {
    expect(parseEditPrompt('参考@图片9', draft().references)).toEqual([
      { kind: 'text', text: '参考@图片9' },
    ])
  })
})
