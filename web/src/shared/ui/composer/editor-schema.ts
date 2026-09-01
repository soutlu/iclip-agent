/**
 * 输入框的 ProseMirror 文档模型（照 kimi 网页版 composer 的极小 schema）。
 *
 * `doc -> paragraph -> text | attachment`；附件是 inline + atom + selectable 的叶子节点，
 * 在文字流里占一个位置：随光标移动、点选后整体选中、退格整颗删除。真正的渲染由
 * NodeView 接管（见 use-composer-editor），这里的 toDOM/parseDOM 只是序列化与兜底形状。
 */

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
      // 复制到剪贴板时留下可读的文件名（pill 的跨次还原本项目不做）
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

/** 文档里按出现顺序收集附件 id（去重，同一颗 pill 只算一次）。 */
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

/**
 * 取出文档里用户打的字：附件节点不算正文，段落之间用 `\n` 连接。
 *
 * 正文里没有附件占位符——附件随 content 里的媒体项单独上行（kimi 的
 * `kimi-code-composer://attachments/` 链接是给它们自家服务端投影用的，这里的合同不需要）。
 */
export const readComposerText = (doc: PMNode): string =>
  doc.textBetween(0, doc.content.size, '\n', () => '')
