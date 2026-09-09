import { describe, expect, it } from 'vitest'
import { compileEditPrompt, parseEditPrompt, resolveImageOptions } from './image-edit.api'
import type { ImageModel } from './image-edit.api'
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

const NANO: ImageModel = {
  model: 'nano_banana_pro',
  label: 'Nano Banana Pro',
  aspectRatios: ['1:1', '4:5', '9:16'],
  resolutions: ['1k', '2k', '4k'],
  channels: ['dev', 'pro'],
}
const SEEDREAM: ImageModel = {
  model: 'seedream_v5_pro',
  label: 'Seedream 5.0 Pro',
  aspectRatios: ['1:1', '9:16'],
  resolutions: ['1k', '2k'],
  channels: [],
}
const WANTED = { model: 'nano_banana_pro', channel: 'dev', resolution: '2k' } as const

describe('resolveImageOptions', () => {
  it('保留调用方想要的那一组', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', WANTED)
    expect(resolved.model?.model).toBe('nano_banana_pro')
    expect(resolved.resolution).toBe('2k')
    expect(resolved.channel).toBe('dev')
  })

  it('所选模型没有渠道这个轴时不给渠道', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', {
      ...WANTED,
      model: 'seedream_v5_pro',
    })
    expect(resolved.channel).toBeUndefined()
  })

  it('档位落在所选模型范围外时退到它最高的一档', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', {
      ...WANTED,
      model: 'seedream_v5_pro',
      resolution: '4k',
    })
    expect(resolved.resolution).toBe('2k')
  })

  it('画幅这家出不了就换成出得了的那家', () => {
    const resolved = resolveImageOptions([SEEDREAM, NANO], '4:5', WANTED)
    expect(resolved.model?.model).toBe('nano_banana_pro')
  })

  it('一家都出不了这个画幅时报出来，而不是挑一家去撞 422', () => {
    const resolved = resolveImageOptions([SEEDREAM], '4:5', WANTED)
    expect(resolved.model).toBeUndefined()
    expect(resolved.aspectUnsupported).toBe(true)
  })

  it('模型还没加载完不算画幅不支持', () => {
    expect(resolveImageOptions([], '4:5', WANTED).aspectUnsupported).toBe(false)
  })
})
