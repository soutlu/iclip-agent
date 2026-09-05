import { Popover } from 'radix-ui'
import type { HTMLAttributes } from 'react'
import { useMemo } from 'react'
import { cn } from '@/shared/lib/utils'

interface PopupContentProps extends HTMLAttributes<HTMLDivElement> {
  anchorRect: DOMRect | null
  align?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  onDismiss: () => void
  open: boolean
}

const ALIGN_OFFSET = 4

const ALIGN_PLACEMENT: Record<
  NonNullable<PopupContentProps['align']>,
  { align: 'start' | 'end'; side: 'bottom' | 'top' }
> = {
  'bottom-end': { align: 'end', side: 'bottom' },
  'bottom-start': { align: 'start', side: 'bottom' },
  'top-end': { align: 'end', side: 'top' },
  'top-start': { align: 'start', side: 'top' },
}

/** Radix 负责定位、碰撞与关闭；不自动抢焦点，anchorRect 为 null 时保持挂载但不可见。 */
export function PopupContent({
  anchorRect,
  align = 'bottom-start',
  children,
  className = '',
  onDismiss,
  open,
  style,
  ...props
}: PopupContentProps) {
  const placement = ALIGN_PLACEMENT[align]
  // 虚拟锚点仅在 anchorRect 变化时更换引用，避免 Radix 每次渲染都触发重定位。
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => anchorRect ?? new DOMRect(),
      },
    }),
    [anchorRect],
  )

  return (
    <Popover.Root
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDismiss()
        }
      }}
    >
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          align={placement.align}
          side={placement.side}
          sideOffset={ALIGN_OFFSET}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={cn(
            'layer-popup rounded-md border-[0.5px] border-border bg-popup-bg shadow-[var(--shadow-2)] backdrop-blur-[40px]',
            'data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:zoom-out-95 data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:duration-(--dur-m) data-[state=open]:ease-(--ease-decel) data-[state=open]:zoom-in-95 data-[state=open]:fade-in',
            className,
          )}
          style={anchorRect ? style : { ...style, visibility: 'hidden' }}
          {...props}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
