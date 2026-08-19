import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { MEDIA_REFERENCE_SUGGESTION_PLUGIN_KEY } from '@/shared/composer/media-reference-suggestion'

interface ComposerSubmitExtensionOptions {
  onSubmitRequest: () => void
}

/**
 * 把普通 Enter 转成 Composer submit intent，并保留 IME、Suggestion 与换行优先级。
 */
export const ComposerSubmitExtension = Extension.create<ComposerSubmitExtensionOptions>({
  name: 'composerSubmit',
  priority: 1000,

  addOptions() {
    return {
      onSubmitRequest: () => {
        throw new Error('ComposerSubmitExtension 缺少 onSubmitRequest 配置。')
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey(this.name),
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== 'Enter' || event.shiftKey) {
              return false
            }

            if (event.isComposing || view.composing || event.keyCode === 229) {
              return false
            }

            const suggestionState = MEDIA_REFERENCE_SUGGESTION_PLUGIN_KEY.getState(view.state)

            if (suggestionState?.active) {
              return false
            }

            this.options.onSubmitRequest()
            return true
          },
        },
      }),
    ]
  },
})
