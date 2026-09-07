import { type Node as PMNode, Schema } from 'prosemirror-model'
import type { EditInstruction } from './image-edit-types'

/** 图片编辑私有 schema；引用身份与显示编号分离。 */
const instructionSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    reference: {
      atom: true,
      inline: true,
      group: 'inline',
      attrs: { kind: {}, id: {} },
      toDOM: (node) => ['span', {}, String(node.attrs['id'])],
    },
  },
})
export function instructionNode(name: 'doc' | 'paragraph' | 'reference') {
  const type = instructionSchema.nodes[name]
  if (type === undefined) throw new Error(`缺少图片编辑节点 ${name}`)
  return type
}
/** 换行映射到段落，保留空行、前后空格及引用出现的顺序。 */
export function instructionsToDoc(parts: readonly EditInstruction[]): PMNode {
  const paragraphs: PMNode[][] = [[]]
  for (const part of parts) {
    if (part.kind !== 'text') {
      paragraphs.at(-1)?.push(instructionNode('reference').create(part))
      continue
    }
    part.text.split('\n').forEach((text, index) => {
      if (index > 0) paragraphs.push([])
      if (text.length > 0) paragraphs.at(-1)?.push(instructionSchema.text(text))
    })
  }
  return instructionNode('doc').create(
    null,
    paragraphs.map((children) => instructionNode('paragraph').create(null, children)),
  )
}
export function docToInstructions(doc: PMNode): EditInstruction[] {
  const parts: EditInstruction[] = []
  const appendText = (text: string) => {
    const previous = parts.at(-1)
    if (previous?.kind === 'text') previous.text += text
    else if (text.length > 0) parts.push({ kind: 'text', text })
  }
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) appendText('\n')
    paragraph.forEach((node) => {
      if (node.isText) appendText(node.text ?? '')
      else
        parts.push({
          kind: node.attrs['kind'] as 'annotation' | 'referenceImage',
          id: node.attrs['id'] as string,
        })
    })
  })
  return parts
}
