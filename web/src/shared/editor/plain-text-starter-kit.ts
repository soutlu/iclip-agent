import StarterKit from '@tiptap/starter-kit'

/**
 * 仅保留 doc、paragraph、text 与 hardBreak 的单行/纯文本编辑基础 schema。
 *
 * 业务 Mention 等节点由调用方追加；该 extension 可同时用于 Editor、getSchema 与 generateText。
 */
export const PlainTextStarterKit = StarterKit.configure({
  blockquote: false,
  bold: false,
  bulletList: false,
  code: false,
  codeBlock: false,
  dropcursor: false,
  gapcursor: false,
  heading: false,
  horizontalRule: false,
  italic: false,
  link: false,
  listItem: false,
  listKeymap: false,
  orderedList: false,
  strike: false,
  trailingNode: false,
  underline: false,
})
