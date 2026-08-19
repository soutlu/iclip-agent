import { ReactRenderer } from '@tiptap/react'
import type { PluginKey } from '@tiptap/pm/state'
import { exitSuggestion, type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion'
import type { ComponentType } from 'react'

export type ReferenceSuggestionMenuProps<Item> = {
  items: Item[]
  onSelect: (item: Item) => void
  selectedIndex: number
}

type ReferenceSuggestionRendererOptions<Item, Selection> = {
  className?: string
  component: ComponentType<ReferenceSuggestionMenuProps<Item>>
  pluginKey: PluginKey
  toSelection: (item: Item) => Selection
}

/**
 * 创建引用候选菜单共用的 React Suggestion 生命周期。
 *
 * 搜索、排序、菜单展示和 Mention 序列化仍由调用方负责；本模块只统一挂载、键盘选择和销毁。
 *
 * @param options - 菜单组件、Suggestion plugin key 与业务项到 Mention attrs 的投影。
 * @returns 可直接交给官方 TipTap Suggestion 配置的 render 函数。
 */
export const createReferenceSuggestionRenderer =
  <Item, Selection>({
    className = 'layer-popup',
    component,
    pluginKey,
    toSelection,
  }: ReferenceSuggestionRendererOptions<Item, Selection>): NonNullable<
    SuggestionOptions<Item, Selection>['render']
  > =>
  () => {
    let currentProps: SuggestionProps<Item, Selection> | null = null
    let renderer: ReactRenderer<unknown, ReferenceSuggestionMenuProps<Item>> | null = null
    let selectedIndex = 0
    let unmount: (() => void) | null = null

    /**
     * 使用最新候选项和当前键盘索引刷新 React 菜单。
     *
     * @returns 无返回值；未挂载或没有 Suggestion 状态时不执行更新。
     */
    const updateRenderer = () => {
      if (!renderer || !currentProps) return

      const props = currentProps
      renderer.updateProps({
        items: props.items,
        onSelect: (item: Item) => props.command(toSelection(item)),
        selectedIndex,
      })
    }

    return {
      onStart: (props) => {
        currentProps = props
        selectedIndex = 0
        renderer = new ReactRenderer(component, {
          className,
          editor: props.editor,
          props: {
            items: props.items,
            onSelect: (item: Item) => props.command(toSelection(item)),
            selectedIndex,
          },
        })
        unmount = props.mount(renderer.element)
      },
      onUpdate: (props) => {
        currentProps = props
        selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1))
        updateRenderer()
      },
      onKeyDown: ({ event, view }) => {
        if (
          event.key === 'Enter' &&
          (event.shiftKey || event.isComposing || view.composing || event.keyCode === 229)
        ) {
          return false
        }

        if (!currentProps) return false

        if (event.key === 'Enter' && currentProps.items.length === 0) {
          exitSuggestion(view, pluginKey)
          return true
        }

        if (currentProps.items.length === 0) {
          return event.key === 'ArrowDown' || event.key === 'ArrowUp'
        }

        if (event.key === 'ArrowDown') {
          selectedIndex = (selectedIndex + 1) % currentProps.items.length
          updateRenderer()
          return true
        }

        if (event.key === 'ArrowUp') {
          selectedIndex =
            (selectedIndex - 1 + currentProps.items.length) % currentProps.items.length
          updateRenderer()
          return true
        }

        if (event.key === 'Enter') {
          const item = currentProps.items[selectedIndex]
          if (item) currentProps.command(toSelection(item))
          return true
        }

        return false
      },
      onExit: () => {
        unmount?.()
        renderer?.destroy()
        unmount = null
        renderer = null
        currentProps = null
      },
    }
  }
