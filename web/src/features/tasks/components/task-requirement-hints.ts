import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { isRequirementLineEmpty, matchRequirementSection } from './task-requirement-template'

type HintsState = {
  decorations: DecorationSet
  focused: boolean
}

/** 供编辑器 onFocus / onBlur 派发焦点变化 meta 使用。 */
export const taskRequirementHintsKey = new PluginKey<HintsState>('taskRequirementHints')

/**
 * 找到光标所在文本块的起始位置。
 *
 * @param state - 当前编辑器状态。
 * @returns 文本块 pos；光标不在文本块内时为 null。
 */
const caretBlockPos = (state: EditorState): null | number => {
  const $head = state.selection.$head
  for (let depth = $head.depth; depth > 0; depth--) {
    if ($head.node(depth).isTextblock) {
      return $head.before(depth)
    }
  }
  return null
}

/**
 * 为「标题:」后尚未填写内容的行挂上灰字示例占位；跳过正在输入的行。
 *
 * @param doc - 当前编辑器文档。
 * @param skipPos - 需要隐藏占位的行（光标所在行）起始位置。
 * @returns 携带 data-section-hint 的行级装饰集合。
 */
const buildHintDecorations = (doc: ProseMirrorNode, skipPos: null | number): DecorationSet => {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true
    }
    const section = matchRequirementSection(node.textContent)
    if (!section) {
      return false
    }
    if (pos !== skipPos && isRequirementLineEmpty(node.textContent, section)) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { 'data-section-hint': section.hint }),
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** 冒号后的灰字示例占位：默认常显，光标落到该行或已填写内容时消失。 */
export const TaskRequirementHints = Extension.create({
  name: 'taskRequirementHints',

  addProseMirrorPlugins() {
    return [
      new Plugin<HintsState>({
        key: taskRequirementHintsKey,
        props: {
          decorations(state) {
            return this.getState(state)?.decorations
          },
        },
        state: {
          apply: (transaction, previous, _oldState, newState) => {
            const focusMeta: unknown = transaction.getMeta(taskRequirementHintsKey)
            const focused = typeof focusMeta === 'boolean' ? focusMeta : previous.focused
            if (
              !transaction.docChanged &&
              !transaction.selectionSet &&
              typeof focusMeta !== 'boolean'
            ) {
              return previous
            }
            return {
              decorations: buildHintDecorations(
                newState.doc,
                focused ? caretBlockPos(newState) : null,
              ),
              focused,
            }
          },
          init: (_config, state) => ({
            decorations: buildHintDecorations(state.doc, null),
            focused: false,
          }),
        },
      }),
    ]
  },
})
