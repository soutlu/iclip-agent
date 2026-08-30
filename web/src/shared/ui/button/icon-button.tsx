import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

export const iconButtonVariants = cva(
  'relative inline-grid ui-state cursor-pointer place-items-center rounded-full ui-focus',
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
        // xs 不外扩热区：它只出现在行尾，两个并排时 48 的热区会互相盖住，
        // 点右边那个会命中左边那个。够不着的用户点整行。
        xs: 'size-(--control-height-xs)',
      },
    },
    defaultVariants: { variant: 'standard', size: 'lg' },
  },
)

const ICON_SIZE = { lg: 'lg', md: 'md', xs: 'sm' } as const

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> &
  VariantProps<typeof iconButtonVariants> & {
    // 图标按钮没有可见文字，可访问名只能由这里给，所以是必填
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
