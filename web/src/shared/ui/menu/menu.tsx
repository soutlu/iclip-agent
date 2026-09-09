import { DropdownMenu } from 'radix-ui'
import type { ComponentPropsWithoutRef } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

export const MenuRoot = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger
export const MenuRadioGroup = DropdownMenu.RadioGroup

const ITEM_CLASS =
  // design-allow -- Radix 用 .focus() 移动高亮，浏览器默认框会和 ui-focus 的焦点环叠一起
  'ui-state ui-focus flex h-(--control-height-sm) cursor-pointer items-center gap-2 rounded-sm px-2 text-body outline-none select-none'

export function MenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator className={cn('my-1 h-px bg-outline-variant', className)} {...props} />
  )
}

export function MenuSurface({
  className,
  sideOffset = 4,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={cn(
          'layer-popup flex min-w-36 flex-col gap-0.5 rounded-md border-[0.5px] border-border bg-popup-bg p-1 shadow-[var(--shadow-2)] backdrop-blur-[40px]',
          'data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:zoom-out-95 data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:duration-(--dur-m) data-[state=open]:ease-(--ease-decel) data-[state=open]:zoom-in-95 data-[state=open]:fade-in',
          className,
        )}
        sideOffset={sideOffset}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

type MenuItemProps = ComponentPropsWithoutRef<typeof DropdownMenu.Item> & {
  destructive?: boolean
  icon?: Parameters<typeof Icon>[0]['name']
  shortcut?: readonly string[]
}

export function MenuItem({
  children,
  className,
  destructive = false,
  icon,
  shortcut,
  ...props
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={cn(ITEM_CLASS, destructive ? 'text-error' : 'text-on-surface', className)}
      {...props}
    >
      {icon ? (
        <Icon className="shrink-0 text-on-surface-variant" decorative name={icon} size="sm" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut?.length ? (
        <span className="ml-4 flex shrink-0 items-center gap-1 text-label text-on-surface-variant">
          {shortcut.map((key) => (
            <span key={key}>{key}</span>
          ))}
        </span>
      ) : null}
    </DropdownMenu.Item>
  )
}

export function MenuRadioItem({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem
      className={cn(ITEM_CLASS, 'justify-between text-on-surface', className)}
      {...props}
    >
      {children}
      <DropdownMenu.ItemIndicator asChild>
        <Icon className="text-primary" decorative name="check" size="md" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  )
}
