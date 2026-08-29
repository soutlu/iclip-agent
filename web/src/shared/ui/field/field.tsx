import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

const FIELD_CLASS =
  'ui-state ui-focus w-full rounded-lg border border-input-border bg-input-bg px-[15px] text-body text-on-surface placeholder:text-on-surface-variant focus-visible:border-primary aria-invalid:border-error'

type InputProps = ComponentPropsWithRef<'input'> & {
  /** 字段左侧的语义图标；搜索框就是它带 name="search"，不另开变体 */
  leadingIcon?: IconName
  trailingAction?: ReactNode
}

export function Input({ className, leadingIcon, trailingAction, ...props }: InputProps) {
  const field = (
    <input
      className={cn(
        FIELD_CLASS,
        'h-(--control-height-xl)',
        leadingIcon ? 'border-0 bg-transparent px-0 focus-visible:border-0' : '',
        className,
      )}
      {...props}
    />
  )

  if (!leadingIcon && !trailingAction) return field

  return (
    <span
      className={cn(
        FIELD_CLASS,
        'inline-flex h-(--control-height-xl) items-center gap-2 focus-within:border-primary',
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
  return <textarea className={cn(FIELD_CLASS, 'py-3', className)} rows={rows} {...props} />
}
