import { PluginKey } from '@tiptap/pm/state'
import { configureEditorReferenceMention, type EditorReferenceMap } from '@/shared/editor'
import { StoryboardInstructionReferenceMention } from '@/features/storyboards/components/storyboard-instruction'

export const STORYBOARD_INSTRUCTION_SUGGESTION_PLUGIN_KEY = new PluginKey<{
  active: boolean
}>('storyboardInstructionReferenceSuggestion')

/**
 * 用共享引用协议配置 Storyboard Mention，仅保留检查器所需的弹层方向。
 * 节点实例与校验 schema 列表共用同一个 `StoryboardInstructionReferenceMention`。
 *
 * @param options - 最新 Storyboard 引用目录 getter。
 * @returns 使用底部弹层方向的共享 Mention extension。
 */
export const createStoryboardInstructionMention = ({
  getReferences,
}: {
  getReferences: () => EditorReferenceMap
}) =>
  configureEditorReferenceMention({
    getReferences,
    node: StoryboardInstructionReferenceMention,
    placement: 'bottom-start',
    pluginKey: STORYBOARD_INSTRUCTION_SUGGESTION_PLUGIN_KEY,
  })
