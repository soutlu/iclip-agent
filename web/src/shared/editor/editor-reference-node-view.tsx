import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useContext } from 'react'
import { EditorReferenceContext } from '@/shared/editor/editor-reference-context'
import { EditorReferenceChip } from '@/shared/editor/editor-reference-ui'

/**
 * 从当前引用目录解析 Mention，并渲染共享 chip 或明确失效态。
 *
 * @param props - Tiptap React NodeView 属性。
 * @returns 可交互引用 chip；引用不存在时返回不可提交的失效 chip。
 * @throws 当编辑器未装配共享引用 Context 时抛出错误。
 */
export default function EditorReferenceNodeView({ node }: NodeViewProps) {
  const context = useContext(EditorReferenceContext)

  if (!context) throw new Error('编辑器引用 NodeView 缺少引用目录。')

  const referenceId: string = node.attrs.id
  const reference = context.references.get(referenceId)

  if (!reference) {
    return (
      <NodeViewWrapper
        as="span"
        className="editor-reference-chip editor-reference-chip--invalid"
        contentEditable={false}
        data-editor-reference-id={referenceId}
      >
        引用已失效
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      data-editor-reference-id={reference.id}
      data-reference-kind={reference.kind}
    >
      <EditorReferenceChip onActivate={context.onActivate} reference={reference} />
    </NodeViewWrapper>
  )
}
