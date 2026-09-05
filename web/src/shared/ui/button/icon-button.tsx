import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

export const iconButtonVariants = cva(
  'relative inline-grid ui-state cursor-pointer place-items-center rounded-sm ui-focus active:scale-[0.98]',
  {
    variants: {
      variant: {
        standard: 'bg-transparent text-on-surface-variant',
        tonal: 'bg-secondary-container text-on-secondary-container',
        selected: 'bg-primary-container text-on-primary-container',
      },
      size: {
        lg: 'hit-48 size-(--control-height-lg)',
        md: 'hit-48 size-(--control-height-md)',
        // sm 与 xs 不扩大热区，避免密排按钮的 48px 点击区域互相覆盖。
        sm: 'size-(--control-height-sm)',
        xs: 'size-(--control-height-xs)',
      },
    },
    defaultVariants: { variant: 'standard', size: 'lg' },
  },
)

const ICON_SIZE = { lg: 'lg', md: 'md', sm: 'md', xs: 'sm' } as const

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> &
  VariantProps<typeof iconButtonVariants> & {
    // 图标按钮无可见文字，label 必须提供可访问名称。
    label: string
    name: IconName
  }

export function IconButton({
  className,
  label,
  name,
  size,
  type = 'button',
  variant,
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={cn(iconButtonVariants({ variant, size }), className)}
      type={type}
      {...props}
    >
      <Icon decorative name={name} size={ICON_SIZE[size ?? 'lg']} />
    </button>
  )
}
