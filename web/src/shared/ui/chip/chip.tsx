import { ToggleGroup } from 'radix-ui'
import type { ComponentPropsWithRef, ComponentPropsWithoutRef, ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

const CHIP_CLASS =
  'ui-state ui-focus hit-48 relative inline-flex h-(--control-height-sm) cursor-pointer items-center gap-[7px] rounded-full border border-chip-border bg-chip-bg px-[15px] text-body-sm font-medium text-on-surface-variant'

const SELECTED_CLASS =
  'data-[state=on]:border-transparent data-[state=on]:bg-state-active data-[state=on]:text-on-surface'

export function ChipGroup({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ToggleGroup.Root>) {
  return (
    <ToggleGroup.Root className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
  )
}

type FilterChipProps = ComponentPropsWithoutRef<typeof ToggleGroup.Item> & {
  children: ReactNode
  leadingIcon?: IconName
}

export function FilterChip({ children, className, leadingIcon, ...props }: FilterChipProps) {
  return (
    <ToggleGroup.Item className={cn(CHIP_CLASS, SELECTED_CLASS, className)} {...props}>
      {leadingIcon ? <Icon decorative name={leadingIcon} size="sm" /> : null}
      {children}
    </ToggleGroup.Item>
  )
}

type AssistChipProps = ComponentPropsWithRef<'button'> & {
  children: ReactNode
  leadingIcon?: IconName
}

/** 触发动作，不参与选择状态。 */
export function AssistChip({
  children,
  className,
  leadingIcon,
  type = 'button',
  ...props
}: AssistChipProps) {
  return (
    <button className={cn(CHIP_CLASS, className)} type={type} {...props}>
      {leadingIcon ? <Icon decorative name={leadingIcon} size="sm" /> : null}
      {children}
    </button>
  )
}
