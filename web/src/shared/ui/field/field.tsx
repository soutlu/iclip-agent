import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

// 带图标时外壳承担边框与背景，input 只应用文字样式，避免重复边框。
const FIELD_SURFACE =
  'ui-state w-full rounded-lg border border-input-border bg-input-bg px-[15px] focus-within:border-primary aria-invalid:border-error'
const FIELD_TEXT = 'text-body text-on-surface placeholder:text-on-surface-faint'
const NESTED_INPUT_CLASS =
  'field-nested-input h-full min-w-0 flex-1 bg-transparent disabled:cursor-not-allowed disabled:text-disabled-text'

type InputProps = ComponentPropsWithRef<'input'> & {
  leadingIcon?: IconName
  trailingAction?: ReactNode
  /** 带图标时 wrapperClassName 控制外壳，className 控制内部 input。 */
  wrapperClassName?: string
}

export function Input({
  className,
  leadingIcon,
  trailingAction,
  wrapperClassName,
  ...props
}: InputProps) {
  const wrapped = Boolean(leadingIcon || trailingAction)
  const field = (
    <input
      className={cn(
        FIELD_TEXT,
        wrapped ? NESTED_INPUT_CLASS : cn(FIELD_SURFACE, 'h-(--control-height-xl) ui-focus'),
        className,
      )}
      {...props}
    />
  )

  if (!wrapped) return field

  return (
    <span
      className={cn(
        FIELD_SURFACE,
        'inline-flex h-(--control-height-xl) items-center gap-2 has-[[aria-invalid=true]]:border-error',
        wrapperClassName,
      )}
    >
      <Icon
        className="shrink-0 text-on-surface-variant"
        decorative
        name={leadingIcon ?? 'search'}
        size="lg"
      />
      {field}
      {trailingAction}
    </span>
  )
}

export function Textarea({ className, rows = 2, ...props }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea
      className={cn(FIELD_SURFACE, FIELD_TEXT, 'py-3 ui-focus', className)}
      rows={rows}
      {...props}
    />
  )
}

// inline 变体没有原生下拉箭头（appearance-none），由外壳补一个；两者必须成对出现。
const selectVariants = cva(cn(FIELD_TEXT, 'w-full ui-focus'), {
  variants: {
    variant: {
      outlined: cn(FIELD_SURFACE, 'h-(--control-height-xl)'),
      inline:
        'h-(--control-height-md) cursor-pointer appearance-none rounded-xs border-0 bg-transparent pr-6 text-ellipsis disabled:cursor-default disabled:text-disabled-text [&_option]:bg-surface-container-lowest [&_option]:text-on-surface',
    },
  },
  defaultVariants: { variant: 'outlined' },
})

type SelectProps = ComponentPropsWithRef<'select'> &
  VariantProps<typeof selectVariants> & {
    /** inline 变体的外壳，由它承担在父布局里的尺寸。 */
    wrapperClassName?: string
  }

export function Select({ className, variant, wrapperClassName, ...props }: SelectProps) {
  const field = <select className={cn(selectVariants({ variant }), className)} {...props} />
  if (variant !== 'inline') return field

  return (
    <span className={cn('relative inline-block min-w-0', wrapperClassName)}>
      {field}
      <Icon
        className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 text-on-surface-muted"
        decorative
        name="expand"
        size="sm"
      />
    </span>
  )
}
