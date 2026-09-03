/**
 * 描述编辑器的文档模型：`doc → paragraph+ → text | frame`，与 `PromptLine[]` 一一对应。
 *
 * 帧记号是 inline atom 节点（与输入框的附件 pill 同一机制）；一行一个 paragraph，外面拼回去的
 * 文本与用户看到的换行完全一致。
 */

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
      // 复制出去还是原文里的写法
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

export const frameNodeType = () => nodeType('frame')

/**
 * 行 → 文档。空行是一个空 paragraph；一行都没有也给一个空 paragraph（schema 要求至少一段）。
 *
 * @param lines - 行。
 * @returns PM 文档。
 */
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

/**
 * 文档 → 行。相邻文字合成一段。
 *
 * @param doc - PM 文档。
 * @returns 行。
 */
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
