/** 下划线式标签页：文字标签，选中项加粗并在容器底边压一条主色线。几何由调用方的容器给。 */

import { Tabs } from 'radix-ui'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/shared/lib/utils'

export const TabsRoot = Tabs.Root
export const TabsContent = Tabs.Content

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof Tabs.List>) {
  return <Tabs.List className={cn('flex min-w-0 items-stretch gap-1', className)} {...props} />
}

const TRIGGER_CLASS = cn(
  // design-allow -- Radix 用 .focus() 移动高亮，浏览器默认框会和 ui-focus 的焦点环叠一起
  'relative flex min-w-0 cursor-pointer items-center rounded-xs px-2 text-body text-on-surface-variant ui-focus outline-none select-none',
  'ui-motion-s hover:text-on-surface data-[state=active]:font-medium data-[state=active]:text-on-surface',
  'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity after:duration-(--dur-s) data-[state=active]:after:opacity-100',
)

export function TabsTrigger({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Tabs.Trigger>) {
  return (
    <Tabs.Trigger className={cn(TRIGGER_CLASS, className)} {...props}>
      <span className="min-w-0 truncate">{children}</span>
    </Tabs.Trigger>
  )
}
