import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'

type ToastProps = {
  /** 右侧的可选动作，状态由 Button 自己接管 */
  action?: ReactNode
  className?: string
  message: ReactNode
  onDismiss?: () => void
  variant?: 'neutral' | 'error'
}

/**
 * 状态反馈条：容器本身不交互，只有 action 与关闭键可点。
 * 定位交给调用方（各页面的安全区不同），这里只固定表面、层级与排版。
 */
export function Toast({ action, className, message, onDismiss, variant = 'neutral' }: ToastProps) {
  return (
    <div
      className={cn(
        'layer-popup flex max-w-[70vw] items-center gap-[9px] rounded-md py-[9px] pr-[10px] pl-[17px] text-label shadow-[var(--shadow-3)]',
        variant === 'error'
          ? 'bg-error-container text-on-error-container'
          : 'bg-inverse-surface text-inverse-on-surface',
        className,
      )}
      role="status"
    >
      <span className="min-w-0">{message}</span>
      {action}
      {onDismiss ? (
        <IconButton
          className="-mr-1 shrink-0 text-inherit"
          label="关闭提示"
          name="close"
          size="md"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  )
}
