import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

// 字段外观分两层：SURFACE 是那一圈框和底色，TEXT 是字。带图标时 SURFACE 挂在外壳 span 上，
// 里面的 input 只留 TEXT——两层都画框会在字段里套出第二个圆角框。
const FIELD_SURFACE =
  'ui-state w-full rounded-lg border border-input-border bg-input-bg px-[15px] focus-within:border-primary aria-invalid:border-error'
const FIELD_TEXT = 'text-body text-on-surface placeholder:text-on-surface-variant'
// field-nested-input 收掉内层的焦点环（规则在 field.css，见那里的注释）
const NESTED_INPUT_CLASS =
  'field-nested-input h-full min-w-0 flex-1 bg-transparent disabled:cursor-not-allowed disabled:text-disabled-text'

type InputProps = ComponentPropsWithRef<'input'> & {
  /** 字段左侧的语义图标；搜索框就是它带 name="search"，不另开变体 */
  leadingIcon?: IconName
  trailingAction?: ReactNode
}

export function Input({ className, leadingIcon, trailingAction, ...props }: InputProps) {
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
