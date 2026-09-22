import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { isBehindModal } from '@/shared/ui/dialog'

type ReaderOverlayProps = {
  label: string
  children: ReactNode
  onClose: () => void
  className?: string
}

/** 盖在阅读器页面上的抽屉：进来把焦点放到 `[data-reader-focus]`（没有就第一个按钮），Escape 关掉。 */
export function ReaderOverlay({ children, className, label, onClose }: ReaderOverlayProps) {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const target =
      ref.current?.querySelector<HTMLElement>('[data-reader-focus]') ??
      ref.current?.querySelector<HTMLElement>('button')
    target?.focus()
  }, [])
  // 预览灯箱与编辑弹窗都是 Radix 模态：它们接住的 Escape 带着 defaultPrevented，抽屉据此让位。
  const close = useEffectEvent(onClose)
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        isBehindModal(ref.current) ||
        !ref.current?.contains(document.activeElement)
      )
        return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [])
  return (
    <aside
      aria-label={label}
      className={cn(
        'group-prompt-sheet absolute inset-0 flex min-h-0 min-w-0 animate-in flex-col overflow-hidden rounded-t-lg border-[0.5px] border-chat-hairline bg-background shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) slide-in-from-bottom motion-reduce:animate-none',
        className,
      )}
      ref={ref}
    >
      {children}
    </aside>
  )
}
