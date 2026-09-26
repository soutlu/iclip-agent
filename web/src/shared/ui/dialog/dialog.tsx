import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { refuseFileDropProps } from '@/shared/ui/file-drop'

export const DialogRoot = DialogPrimitive.Root
/** 自己排版表头的弹窗（不用 DialogHeader）拿它当可访问标题。 */
export const DialogTitle = DialogPrimitive.Title

type DialogSurfaceProps = ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  children: ReactNode
  /** 不画圆角、底色与阴影：整块交给内部各面板自己承载表面。 */
  bare?: boolean
  /** 画布弹层通过遮罩类名声明 nodrag / nopan。 */
  overlayClassName?: string
}

/** 视口小于 600px 时使用底部 sheet，其余居中；层级与外观遵循设计契约。本体与遮罩是文件拖放的拒收面，协议见 file-drop。 */
export function DialogSurface({
  bare = false,
  children,
  className,
  overlayClassName,
  ...props
}: DialogSurfaceProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn('layer-overlay fixed inset-0 bg-scrim/32 ui-motion-m', overlayClassName)}
        {...refuseFileDropProps}
      />
      <DialogPrimitive.Content
        className={cn(
          'layer-popup fixed flex flex-col text-on-surface',
          !bare &&
            'overflow-hidden rounded-2xl bg-surface-container-lowest shadow-[var(--shadow-3)] max-sm:rounded-t-2xl max-sm:rounded-b-none',
          'top-1/2 left-1/2 max-h-[86vh] w-[calc(100%-32px)] max-w-[582px] -translate-x-1/2 -translate-y-1/2',
          'max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[92vh] max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0',
          'data-[state=open]:animate-in data-[state=open]:duration-(--dur-l) data-[state=open]:ease-(--ease-decel) data-[state=open]:zoom-in-95 data-[state=open]:fade-in',
          'data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:zoom-out-95 data-[state=closed]:fade-out',
          'max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=open]:slide-in-from-bottom',
          className,
        )}
        {...props}
        {...refuseFileDropProps}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

type DialogHeaderProps = {
  actions?: ReactNode
  children?: ReactNode
  className?: string
  closeLabel: string
  title: ReactNode
}

export function DialogHeader({
  actions,
  children,
  className,
  closeLabel,
  title,
}: DialogHeaderProps) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <DialogPrimitive.Title className="truncate text-title-lg font-semibold">
          {title}
        </DialogPrimitive.Title>
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-body-sm text-on-surface-variant">
        {actions}
        <DialogPrimitive.Close asChild>
          <IconButton className="-mr-2" label={closeLabel} name="close" />
        </DialogPrimitive.Close>
      </div>
    </header>
  )
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto p-6', className)}>{children}</div>
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-6 py-4 text-body-sm text-on-surface-variant">
      {children}
    </footer>
  )
}
