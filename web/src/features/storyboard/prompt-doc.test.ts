import { describe, expect, it } from 'vitest'
import {
  applyFrameOp,
  frameMentions,
  parsePromptDoc,
  renumberFrames,
  serializePromptDoc,
  validateShot,
} from './prompt-doc'
import type { Shot } from './shots'

/** 保留 shot-spec.md 示例及模型可能生成的边界格式。 */
const FIXTURES: Record<string, string> = {
  CRLF: '[0–1秒｜镜头1] 开场 @Image1。\r\n[1–2秒｜镜头2] 硬切 @Image2。',
  spec示例: [
    '产品「X」以镜头帧为唯一外观参考，所有镜头中外观保持一致。',
    '人物「X」身份、脸部、发型与穿搭在所有镜头中保持一致。',
    '场景「X」空间结构与光线在所有镜头中保持一致。',
    '',
    '剪辑形式：',
    '[照抄 storyboard.md 的剪辑形式块]',
    '',
    '[0–1秒｜镜头1] 开场，[照抄 Storyline 第 1 镜正文，人物首次出现写成「图中的…」] @Image1，[声音记号]。',
    '[1–1.7秒｜镜头2] 硬切，[照抄 Storyline 第 2 镜正文] @Image2，[声音记号]。',
    '[1.7–3.2秒｜镜头3] 硬切，[照抄 Storyline 第 3 镜正文] @Image3，[后续动作] @Image4。',
    '不要生成字幕，不要生成背景音乐。',
  ].join('\n'),
  半角连字符与竖线: '[0-4秒|镜头1]\n她走向镜头 @Image1。',
  头在行首行尾: '@Image1 开场\n收尾 @Image2',
  尾随空白与空行: '[0–4秒｜镜头1]  \n正文 @Image1 \n\n\n',
  没有时间线: '一整段描述，没有镜头头 @Image1，再来一张 @Image2。',
  前导零不算记号: '这里的 @Image01 不是帧，@Image1 才是。',
  空串: '',
}

describe('parsePromptDoc / serializePromptDoc', () => {
  it.each(Object.entries(FIXTURES))('%s 往返逐字相同', (_name, text) => {
    expect(serializePromptDoc(parsePromptDoc(text))).toBe(text)
  })

  it('时间线头单独成段，前言是第一段', () => {
    const doc = parsePromptDoc('前言\n[0–4秒｜镜头1]\n正文 @Image1')
    expect(doc.sections).toHaveLength(2)
    expect(doc.sections[0]?.header).toBeNull()
    expect(doc.sections[1]?.header).toBe('[0–4秒｜镜头1]')
    expect(doc.sections[1]?.lines).toEqual([
      [
        { kind: 'text', text: '正文 ' },
        { kind: 'frame', n: 1 },
      ],
    ])
  })

  it('前导零的 @Image01 当文字，不当帧', () => {
    expect(frameMentions(parsePromptDoc(FIXTURES['前导零不算记号'] ?? ''))).toEqual([1])
  })
})

describe('renumberFrames', () => {
  it('抠掉的帧连同前面紧贴的一个空格一起走', () => {
    const doc = parsePromptDoc('走向镜头 @Image1，停下 @Image2。')
    const next = renumberFrames(doc, (n) => (n === 1 ? null : n - 1))
    expect(serializePromptDoc(next)).toBe('走向镜头，停下 @Image1。')
  })
})

const shot: Shot = {
  imageUrls: ['a', 'b', 'c'],
  index: 2,
  prompt:
    '[0–4秒｜镜头1]\n她走向镜头 @Image1，脚步放慢。\n[4–11秒｜镜头2]\n停下微笑 @Image2，看包 @Image3。',
  seconds: 11,
}

describe('applyFrameOp', () => {
  it('replace 只换地址，prompt 一字不动', () => {
    const next = applyFrameOp(shot, { n: 2, type: 'replace', url: 'z' })
    expect(next.imageUrls).toEqual(['a', 'z', 'c'])
    expect(next.prompt).toBe(shot.prompt)
  })

  it('remove 抠掉记号并把后面的编号前移', () => {
    const next = applyFrameOp(shot, { n: 2, type: 'remove' })
    expect(next.imageUrls).toEqual(['a', 'c'])
    expect(next.prompt).toBe(
      '[0–4秒｜镜头1]\n她走向镜头 @Image1，脚步放慢。\n[4–11秒｜镜头2]\n停下微笑，看包 @Image2。',
    )
  })

  it('move 交换地址并把夹在中间的编号顺移', () => {
    const next = applyFrameOp(shot, { n: 1, to: 3, type: 'move' })
    expect(next.imageUrls).toEqual(['b', 'c', 'a'])
    expect(next.prompt).toBe(
      '[0–4秒｜镜头1]\n她走向镜头 @Image3，脚步放慢。\n[4–11秒｜镜头2]\n停下微笑 @Image1，看包 @Image2。',
    )
  })

  it('insert 把新帧塞进位置，记号追加到指定段的末行', () => {
    const next = applyFrameOp(shot, { after: 1, sectionIndex: 1, type: 'insert', url: 'n' })
    expect(next.imageUrls).toEqual(['a', 'n', 'b', 'c'])
    expect(next.prompt).toBe(
      '[0–4秒｜镜头1]\n她走向镜头 @Image1，脚步放慢。 @Image2\n[4–11秒｜镜头2]\n停下微笑 @Image3，看包 @Image4。',
    )
  })

  it('越界的编号原样返回', () => {
    expect(applyFrameOp(shot, { n: 9, type: 'remove' })).toBe(shot)
  })

  it.each([
    ['remove', { n: 3, type: 'remove' } as const],
    ['move', { n: 3, to: 1, type: 'move' } as const],
    ['insert', { after: 0, sectionIndex: 2, type: 'insert', url: 'n' } as const],
  ])('%s 之后仍过得了形状预检', (_name, op) => {
    expect(validateShot(applyFrameOp(shot, op))).toBeUndefined()
  })
})

describe('validateShot', () => {
  it('编号超过张数', () => {
    expect(validateShot({ ...shot, imageUrls: ['a'] })).toMatch('@Image2')
  })

  it('秒数越界', () => {
    expect(validateShot({ ...shot, seconds: 31 })).toMatch('4 到 30')
  })

  it('合规就没话说', () => {
    expect(validateShot(shot)).toBeUndefined()
  })
})
