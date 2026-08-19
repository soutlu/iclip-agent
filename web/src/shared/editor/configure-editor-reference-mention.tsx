import type { MentionOptions } from '@tiptap/extension-mention'
import { PluginKey } from '@tiptap/pm/state'
import { ReactNodeViewRenderer } from '@tiptap/react'
import type { SuggestionOptions } from '@tiptap/suggestion'
import type { EditorReference, EditorReferenceMap } from '@/shared/editor/editor-reference'
import { searchEditorReferences } from '@/shared/editor/editor-reference'
import { EditorReferenceSuggestionMenu } from '@/shared/editor/editor-reference-ui'
import EditorReferenceNodeView from '@/shared/editor/editor-reference-node-view'
import { createReferenceSuggestionRenderer } from '@/shared/editor/reference-suggestion-renderer'
import type {
  createStableReferenceMention,
  StableReferenceMentionAttributes,
} from '@/shared/editor/stable-reference-mention'

type EditorReferenceSuggestionPlacement = NonNullable<
  SuggestionOptions<EditorReference, StableReferenceMentionAttributes>['placement']
>

export type ConfigureEditorReferenceMentionOptions = {
  getReferences: () => EditorReferenceMap
  node: ReturnType<typeof createStableReferenceMention>
  placement?: EditorReferenceSuggestionPlacement
  pluginKey?: PluginKey
}

const INVALID_EDITOR_REFERENCE_TEXT = '【引用已失效】'

/**
 * 从未知 Mention 属性中读取稳定引用 ID。
 *
 * @param attributes - Tiptap 节点属性。
 * @returns 有效字符串 ID；属性缺失或类型错误时返回空字符串并交给失效态处理。
 */
const readReferenceId = (attributes: unknown) => {
  if (typeof attributes !== 'object' || attributes === null || !('id' in attributes)) return ''
  return typeof attributes.id === 'string' ? attributes.id : ''
}

/**
 * 配置所有产品输入框共用的 Mention、catalog 搜索、NodeView 和候选菜单。
 * 调用方传入自己领域的 stable mention 节点实例（同一实例同时进入校验
 * schema 列表），保证编辑器与校验的节点定义构造性同源，不存在第二份。
 *
 * @param options - 节点实例、引用目录 getter、Suggestion key 与弹层方向。
 * @returns 使用统一引用规则配置完成的 Tiptap Mention extension。
 */
export const configureEditorReferenceMention = ({
  getReferences,
  node,
  placement = 'top-start',
  pluginKey = new PluginKey(`${node.name}Suggestion`),
}: ConfigureEditorReferenceMentionOptions) => {
  /**
   * 把稳定引用 ID 序列化成当前统一标签或明确的失效占位。
   *
   * @param referenceId - Mention 节点保存的稳定 ID。
   * @returns 剪贴板和 HTML 文本序列化结果。
   */
  const serializeReferenceText = (referenceId: string) => {
    const reference = getReferences().get(referenceId)
    return reference ? `@${reference.label}` : INVALID_EDITOR_REFERENCE_TEXT
  }

  return node
    .extend<MentionOptions<EditorReference, StableReferenceMentionAttributes>>({
      addNodeView() {
        return ReactNodeViewRenderer(EditorReferenceNodeView, { as: 'span' })
      },
    })
    .configure({
      deleteTriggerWithBackspace: true,
      renderHTML: ({ node, options }) => [
        'span',
        options.HTMLAttributes,
        serializeReferenceText(readReferenceId(node.attrs)),
      ],
      renderText: ({ node }) => serializeReferenceText(readReferenceId(node.attrs)),
      suggestion: {
        allowedPrefixes: null,
        char: '@',
        items: ({ query }) => searchEditorReferences(getReferences().values(), query),
        offset: { mainAxis: 8 },
        placement,
        pluginKey,
        render: createReferenceSuggestionRenderer({
          component: EditorReferenceSuggestionMenu,
          pluginKey,
          toSelection: (reference) => ({ id: reference.id }),
        }),
      },
    })
}
