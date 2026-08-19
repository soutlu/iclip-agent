import Mention from '@tiptap/extension-mention'

export type StableReferenceMentionAttributes = {
  id: string
}

/**
 * 创建只保存稳定引用 ID 的官方 Mention 节点。
 *
 * @param nodeName - 调用方领域内唯一的 TipTap 节点名。
 * @returns 可继续配置 NodeView、Suggestion 与序列化规则的 Mention extension。
 */
export const createStableReferenceMention = (nodeName: string) =>
  Mention.extend({
    name: nodeName,

    addAttributes() {
      return {
        id: {
          isRequired: true,
          validate: 'string',
          parseHTML: (element) => element.getAttribute('data-id'),
          renderHTML: (attributes) => ({ 'data-id': attributes.id }),
        },
      }
    },
  })
