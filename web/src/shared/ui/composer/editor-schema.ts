/** 参考 Kimi schema：doc → paragraph → text | attachment。附件为可选中的 inline atom；NodeView 渲染内容，toDOM / parseDOM 负责序列化。 */

import type { Node as PMNode } from 'prosemirror-model'
import { Schema } from 'prosemirror-model'

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    attachment: {
      attrs: {
        attId: {},
        kind: {},
        name: {},
      },
      atom: true,
      group: 'inline',
      inline: true,
      // 复制附件节点时使用可读文件名。
      leafText: (node) => node.attrs['name'] as string,
      parseDOM: [
        {
          getAttrs: (dom) => ({
            attId: dom.getAttribute('data-attachment-id'),
            kind: dom.getAttribute('data-attachment-kind'),
            name: dom.getAttribute('data-attachment-name') ?? dom.textContent,
          }),
          tag: 'span.attachment-pill',
        },
      ],
      selectable: true,
      toDOM: (node) => [
        'span',
        {
          class: `attachment-pill attachment-${node.attrs['kind'] as string}`,
          'data-attachment-id': node.attrs['attId'] as string,
          'data-attachment-kind': node.attrs['kind'] as string,
          'data-attachment-name': node.attrs['name'] as string,
        },
        node.attrs['name'] as string,
      ],
    },
  },
})

/** 按出现顺序收集去重后的附件 ID。 */
export const collectAttachmentIds = (doc: PMNode): string[] => {
  const ids: string[] = []
  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes['attachment']) return true
    const attId = node.attrs['attId'] as string
    if (!ids.includes(attId)) ids.push(attId)
    return true
  })
  return ids
}

export type ComposerSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'attachment'; readonly attId: string }

/** 按文档顺序保留文字与附件，避免失去相邻引用语义；段落以换行分隔并去除首尾空白。 */
export const readComposerSegments = (doc: PMNode): ComposerSegment[] => {
  const segments: ComposerSegment[] = []
  let buffer = ''
  const flush = () => {
    if (buffer.length > 0) segments.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) buffer += '\n'
    paragraph.forEach((child) => {
      if (child.type === composerSchema.nodes['attachment']) {
        flush()
        segments.push({ attId: child.attrs['attId'] as string, kind: 'attachment' })
        return
      }
      buffer += child.text ?? ''
    })
  })
  flush()
  const first = segments[0]
  if (first?.kind === 'text') segments[0] = { kind: 'text', text: first.text.trimStart() }
  const last = segments.at(-1)
  if (last?.kind === 'text')
    segments[segments.length - 1] = { kind: 'text', text: last.text.trimEnd() }
  return segments.filter((segment) => segment.kind !== 'text' || segment.text.length > 0)
}

/** 只提取用户文字，段落以换行连接；附件通过独立媒体 part 提交。 */
export const readComposerText = (doc: PMNode): string =>
  doc.textBetween(0, doc.content.size, '\n', () => '')
