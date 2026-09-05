/** doc → paragraph+ → text | frame；每行对应一个段落，保留 PromptLine[] 的换行。 */

import { type Node as PMNode, Schema } from 'prosemirror-model'
import type { PromptLine } from '../prompt-doc'

export const promptSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    frame: {
      atom: true,
      attrs: { n: {} },
      group: 'inline',
      inline: true,
      leafText: (node) => `@Image${node.attrs['n'] as number}`,
      parseDOM: [
        {
          getAttrs: (dom) => ({ n: Number(dom.getAttribute('data-n')) }),
          tag: 'span.frame-chip',
        },
      ],
      selectable: true,
      toDOM: (node) => [
        'span',
        { class: 'frame-chip', 'data-n': String(node.attrs['n'] as number) },
        `@${node.attrs['n'] as number}`,
      ],
    },
  },
})

const nodeType = (name: 'doc' | 'frame' | 'paragraph') => {
  const type = promptSchema.nodes[name]
  if (type === undefined) throw new Error(`prompt schema 里没有 ${name} 节点`)
  return type
}

/** 空行对应空段落；空列表仍生成一个段落，以满足 schema。 */
export const linesToDoc = (lines: readonly PromptLine[]): PMNode =>
  nodeType('doc').create(
    null,
    (lines.length === 0 ? [[]] : lines).map((line) =>
      nodeType('paragraph').create(
        null,
        line.flatMap((inline) =>
          inline.kind === 'text'
            ? inline.text.length === 0
              ? []
              : [promptSchema.text(inline.text)]
            : [nodeType('frame').create({ n: inline.n })],
        ),
      ),
    ),
  )

/** 转换回行时合并相邻文字节点。 */
export const docToLines = (doc: PMNode): PromptLine[] => {
  const lines: PromptLine[] = []
  doc.forEach((paragraph) => {
    const line: PromptLine = []
    paragraph.forEach((child) => {
      if (child.type === nodeType('frame')) {
        line.push({ kind: 'frame', n: child.attrs['n'] as number })
        return
      }
      const text = child.text ?? ''
      const previous = line.at(-1)
      if (previous?.kind === 'text') {
        line[line.length - 1] = { kind: 'text', text: previous.text + text }
      } else if (text.length > 0) {
        line.push({ kind: 'text', text })
      }
    })
    lines.push(line)
  })
  return lines
}
