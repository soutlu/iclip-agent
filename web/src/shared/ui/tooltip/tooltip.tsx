import { Tooltip } from 'radix-ui'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/** 全应用挂一次；相邻浮层之间的免延迟切换靠同一个 Provider。 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={150}>
      {children}
    </Tooltip.Provider>
  )
}

export const TooltipRoot = Tooltip.Root
export const TooltipTrigger = Tooltip.Trigger

const CONTENT_CLASS =
  'layer-popup max-w-64 rounded-xs bg-inverse-surface px-2 py-1 text-label text-inverse-on-surface shadow-[var(--shadow-2)] data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:fade-out data-[state=delayed-open]:animate-in data-[state=delayed-open]:duration-(--dur-m) data-[state=delayed-open]:ease-(--ease-decel) data-[state=delayed-open]:fade-in'

/** 共用浮层外观：深色小条，挂在 body 上。 */
export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof Tooltip.Content>) {
  return (
    <Tooltip.Portal>
      <Tooltip.Content
        className={cn(CONTENT_CLASS, className)}
        collisionPadding={8}
        sideOffset={sideOffset}
        {...props}
      />
    </Tooltip.Portal>
  )
}
