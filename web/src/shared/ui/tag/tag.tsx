import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/shared/lib/utils'

export const tagVariants = cva(
  'inline-flex h-(--control-height-xs) items-center gap-1.5 rounded-xs px-[9px] text-label font-medium',
  {
    variants: {
      variant: {
        solid: 'bg-secondary-container text-on-secondary-container',
        soft: 'bg-chip-bg text-on-surface-variant',
        success: 'bg-primary-container text-on-primary-container',
        running: 'bg-warning-container text-on-warning-container',
        error: 'bg-error-container text-on-error-container',
      },
    },
    defaultVariants: { variant: 'soft' },
  },
)

type TagProps = ComponentPropsWithRef<'span'> & VariantProps<typeof tagVariants>

/** 纯展示的类型 / 状态 / 计数标签；不承担选择，可选择的用 Chip。 */
export function Tag({ className, variant, ...props }: TagProps) {
  return <span className={cn(tagVariants({ variant }), className)} {...props} />
}
