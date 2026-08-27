import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

export const buttonVariants = cva(
  'hit-48 relative inline-flex ui-state cursor-pointer items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap ui-focus',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-on-primary shadow-[var(--shadow-1)]',
        tonal: 'bg-secondary-container text-on-secondary-container',
        outlined: 'border border-outline bg-transparent text-primary',
        inverted: 'bg-inverse-surface text-inverse-on-surface',
        danger: 'bg-error text-on-error',
        ghost: 'bg-transparent text-on-surface',
      },
      size: {
        lg: 'h-(--control-height-lg) px-[22px] text-body',
        md: 'h-(--control-height-md) px-4 text-body-sm',
      },
    },
    defaultVariants: { variant: 'primary', size: 'lg' },
  },
)

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    children: ReactNode
    leadingIcon?: Parameters<typeof Icon>[0]['name']
    // 转圈期间按钮保持禁用，避免同一动作被点第二次
    loading?: boolean
    trailingIcon?: Parameters<typeof Icon>[0]['name']
  }

export function Button({
  children,
  className,
  disabled,
  leadingIcon,
  loading = false,
  size,
  trailingIcon,
  type = 'button',
  variant,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      type={type}
      {...props}
    >
      {loading ? (
        <Icon className="animate-spin" decorative name="loading" size="md" />
      ) : leadingIcon ? (
        <Icon decorative name={leadingIcon} size="md" />
      ) : null}
      {children}
      {trailingIcon ? <Icon decorative name={trailingIcon} size="md" /> : null}
    </button>
  )
}
