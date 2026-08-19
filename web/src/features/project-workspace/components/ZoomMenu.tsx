import { Popover } from 'radix-ui'
import { useCallback, useEffect } from 'react'
import { useProjectCanvasStore } from '@/features/project-canvas'

interface ZoomMenuItem {
  label: string
  shortcutKeys: string[]
  action: () => void
}

/**
 * 渲染画布缩放操作菜单。
 *
 * 必须挂载在 ZoomControls 的 Popover.Root 内部，菜单出现在触发按钮上方并
 * 右对齐；Escape 与外部点击关闭由 Radix 处理，快捷键监听保持原有实现。
 *
 * @param props - 缩放菜单属性。
 * @param props.onClose - 关闭菜单回调。
 * @returns Portal 到 body 的缩放菜单。
 */
export default function ZoomMenu({ onClose }: { onClose: () => void }) {
  const zoomIn = useProjectCanvasStore((state) => state.zoomIn)
  const zoomOut = useProjectCanvasStore((state) => state.zoomOut)
  const zoomTo100 = useProjectCanvasStore((state) => state.zoomTo100)
  const zoomToFit = useProjectCanvasStore((state) => state.zoomToFit)
  const zoomToSelection = useProjectCanvasStore((state) => state.zoomToSelection)

  const menuItems: ZoomMenuItem[] = [
    { label: 'Zoom in', shortcutKeys: ['⌘', '+'], action: zoomIn },
    { label: 'Zoom out', shortcutKeys: ['⌘', '-'], action: zoomOut },
    { label: 'Zoom to 100%', shortcutKeys: ['⇧', '0'], action: zoomTo100 },
    { label: 'Zoom to Fit', shortcutKeys: ['⇧', '1'], action: zoomToFit },
    { label: 'Zoom to Selection', shortcutKeys: ['⇧', '2'], action: zoomToSelection },
  ]

  const handleItemClick = useCallback(
    (action: () => void) => {
      action()
      onClose()
    },
    [onClose],
  )

  /* Keyboard shortcuts (non-Escape) */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        handleItemClick(zoomIn)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault()
        handleItemClick(zoomOut)
        return
      }
      if (e.shiftKey && e.key === ')') {
        e.preventDefault()
        handleItemClick(zoomTo100)
        return
      }
      if (e.shiftKey && e.key === '!') {
        e.preventDefault()
        handleItemClick(zoomToFit)
        return
      }
      if (e.shiftKey && e.key === '@') {
        e.preventDefault()
        handleItemClick(zoomToSelection)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleItemClick, zoomIn, zoomOut, zoomTo100, zoomToFit, zoomToSelection])

  const btnClass =
    'gap-2 backdrop-blur-[12px] duration-75 ease-out focus-visible:outline-2 focus-visible:outline-current focus-visible:-outline-offset-2 px-3 h-8 text-xs text-[var(--color-on-background)] w-full whitespace-nowrap bg-[var(--color-popup-bg)] rounded-none flex justify-between items-center first:rounded-t-md last:rounded-b-md hover:bg-[var(--color-hover)] active:bg-[var(--color-btn-hover)] transition-colors'

  return (
    <Popover.Portal>
      <Popover.Content
        align="end"
        side="top"
        sideOffset={4}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="overflow-hidden rounded-md border border-[var(--color-border)] shadow-[var(--shadow-2)] backdrop-blur-[12px]"
        style={{ zIndex: 'var(--z-popup)' }}
      >
        {menuItems.map((item) => (
          <button
            key={item.label}
            type="button"
            className={btnClass}
            tabIndex={0}
            onClick={() => handleItemClick(item.action)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleItemClick(item.action)
              }
            }}
          >
            <span>{item.label}</span>
            <div className="ml-4 flex items-center gap-1">
              {item.shortcutKeys.map((key) => (
                <span key={key} className="w-2 text-center text-xs">
                  {key}
                </span>
              ))}
            </div>
          </button>
        ))}
      </Popover.Content>
    </Popover.Portal>
  )
}
