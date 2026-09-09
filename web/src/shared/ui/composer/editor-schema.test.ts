import { describe, expect, it } from 'vitest'
import { composerSchema, readComposerSegments, readComposerText } from './editor-schema'

const nodeType = (name: 'attachment' | 'doc' | 'paragraph') => {
  const type = composerSchema.nodes[name]
  if (type === undefined) throw new Error(`schema 里没有 ${name}`)
  return type
}
const pill = (attId: string) =>
  nodeType('attachment').create({ attId, kind: 'image', name: `${attId}.jpg` })
const paragraph = (...content: ReturnType<typeof composerSchema.text>[]) =>
  nodeType('paragraph').create(null, content)
const doc = (...paragraphs: ReturnType<typeof paragraph>[]) =>
  nodeType('doc').create(null, paragraphs)

describe('readComposerSegments', () => {
  it('文字与 pill 按出现顺序交替，图落在它被提到的那句话旁边', () => {
    const document = doc(
      paragraph(
        composerSchema.text('这一帧换成这张图的角度 '),
        pill('a'),
        composerSchema.text('，鞋侧面要露出透气孔 '),
        pill('b'),
      ),
    )

    expect(readComposerSegments(document)).toEqual([
      { kind: 'text', text: '这一帧换成这张图的角度 ' },
      { attId: 'a', kind: 'attachment' },
      { kind: 'text', text: '，鞋侧面要露出透气孔 ' },
      { attId: 'b', kind: 'attachment' },
    ])
  })

  it('段落之间用换行连，首尾空白去掉，空段不留', () => {
    const document = doc(
      paragraph(composerSchema.text('  第一行')),
      paragraph(),
      paragraph(composerSchema.text('第三行  ')),
    )

    expect(readComposerSegments(document)).toEqual([{ kind: 'text', text: '第一行\n\n第三行' }])
  })

  it('只有 pill 没有字：没有文字段', () => {
    expect(readComposerSegments(doc(paragraph(pill('a'))))).toEqual([
      { attId: 'a', kind: 'attachment' },
    ])
  })

  it('压平的文字与切段拼回去一致', () => {
    const document = doc(
      paragraph(composerSchema.text('看这张 '), pill('a'), composerSchema.text(' 再改')),
    )
    const flat = readComposerSegments(document)
      .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
      .join('')
    expect(flat).toBe(readComposerText(document))
  })
})
