import { Popover } from 'radix-ui'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/shared/lib/utils'

export const PopupRoot = Popover.Root
export const PopupAnchor = Popover.Anchor
export const PopupTrigger = Popover.Trigger

/** 浮层表面与进退场动画；弹层与菜单（@/shared/ui/menu）共用同一套外观。 */
export const POPUP_SURFACE_CLASS = [
  'layer-popup rounded-md border-[0.5px] border-border bg-popup-bg shadow-[var(--shadow-2)] backdrop-blur-[40px]',
  'data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:zoom-out-95 data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:duration-(--dur-m) data-[state=open]:ease-(--ease-decel) data-[state=open]:zoom-in-95 data-[state=open]:fade-in',
].join(' ')

type PopupSurfaceProps = ComponentPropsWithoutRef<typeof Popover.Content> & {
  showArrow?: boolean
}

/** 共用弹层外观；触发按钮的焦点与键盘关闭由 Radix 管理。 */
export function PopupSurface({
  children,
  className,
  showArrow = false,
  ...props
}: PopupSurfaceProps) {
  return (
    <Popover.Portal>
      <Popover.Content className={cn(POPUP_SURFACE_CLASS, className)} {...props}>
        {children}
        {showArrow ? <Popover.Arrow className="fill-popup-bg" height={8} width={16} /> : null}
      </Popover.Content>
    </Popover.Portal>
  )
}
