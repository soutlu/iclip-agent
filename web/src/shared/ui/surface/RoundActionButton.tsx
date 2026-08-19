import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

interface RoundActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  isActive?: boolean
  /** 'icon' = 32×32 square, 'pill' = 32px height with horizontal padding */
  shape?: 'icon' | 'pill'
}

const SHAPE_CLASS = {
  icon: 'h-8 w-8',
  pill: 'h-8 px-3 gap-1.5',
} as const

export default function RoundActionButton({
  children,
  className = '',
  isActive = false,
  shape = 'icon',
  ...props
}: RoundActionButtonProps) {
  const stateClass = isActive
    ? 'bg-[var(--color-state-active)] text-[var(--color-on-background)]'
    : 'surface-button'

  return (
    <button
      type="button"
      className={cn(
        'hit-48 relative inline-flex items-center justify-center rounded-full text-body-sm font-medium',
        SHAPE_CLASS[shape],
        stateClass,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
