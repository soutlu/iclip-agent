import type { MediaComposerReferenceMap } from '@/shared/composer/media-composer'
import { MediaReferenceMention } from '@/shared/composer/media-composer-schema'
import { MEDIA_REFERENCE_SUGGESTION_PLUGIN_KEY } from '@/shared/composer/media-reference-suggestion'
import { configureEditorReferenceMention } from '@/shared/editor'

/**
 * 使用当前引用目录 getter 配置官方 Mention extension。
 * 节点实例与校验 schema 列表共用同一个 `MediaReferenceMention`。
 *
 * @param options - Editor 生命周期依赖。
 * @param options.getReferences - 读取 React 当前派生引用目录的稳定函数。
 * @returns 已配置 Suggestion、NodeView 与文本序列化的 Mention extension。
 */
export const configureMediaReferenceMention = ({
  getReferences,
}: {
  getReferences: () => MediaComposerReferenceMap
}) => {
  return configureEditorReferenceMention({
    getReferences,
    node: MediaReferenceMention,
    placement: 'top-start',
    pluginKey: MEDIA_REFERENCE_SUGGESTION_PLUGIN_KEY,
  })
}
