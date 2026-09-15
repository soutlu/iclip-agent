import { useEffect, useEffectEvent } from 'react'

/**
 * 让弹窗里的非 Radix 浮层（如编辑器的引用菜单）先于 Dialog 接住 Escape。
 * Dialog 在 document 捕获阶段监听、见 defaultPrevented 就让位；只有 window 捕获阶段跑得比它更早。
 */
export function useEscapeAheadOfDialog(active: boolean, onEscape: () => void) {
  const escape = useEffectEvent(onEscape)
  useEffect(() => {
    if (!active) return
    const claim = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      escape()
    }
    window.addEventListener('keydown', claim, { capture: true })
    return () => window.removeEventListener('keydown', claim, { capture: true })
  }, [active])
}
