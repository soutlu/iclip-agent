import { DropdownMenu } from 'radix-ui'
import type { ComponentPropsWithoutRef } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

export const MenuRoot = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger
export const MenuRadioGroup = DropdownMenu.RadioGroup

const ITEM_CLASS =
  // design-allow -- Radix 用 .focus() 移动高亮，浏览器默认框会和 ui-focus 的焦点环叠一起
  'ui-state ui-focus flex h-(--control-height-md) cursor-pointer items-center gap-2 rounded-sm px-3 text-body outline-none select-none'

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
          'layer-popup popup-menu-enter min-w-[180px] rounded-md border border-border bg-popup-bg p-1 shadow-[var(--shadow-2)] backdrop-blur-[40px]',
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
  /** 行尾快捷键提示，如 ['⌘', '+'] */
  shortcut?: readonly string[]
}

export function MenuItem({
  children,
  className,
  destructive = false,
  shortcut,
  ...props
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={cn(
        ITEM_CLASS,
        'justify-between',
        destructive ? 'text-error' : 'text-on-surface',
        className,
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
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

/** 单选菜单项：选中标记由 Radix 的 ItemIndicator 挂在行尾。 */
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
