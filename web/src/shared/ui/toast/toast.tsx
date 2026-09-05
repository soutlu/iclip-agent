import { Toaster as SonnerToaster, toast } from 'sonner'

export { toast }

/** 应用仅挂载一次 Toaster；sonner 管理交互，classNames 提供契约外观。默认 4 秒，带 action 时调用方设置 8 秒。 */
export function Toaster() {
  return (
    <SonnerToaster
      duration={4000}
      position="bottom-center"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-center gap-[9px] rounded-md bg-inverse-surface py-[9px] pr-[10px] pl-[17px] text-label text-inverse-on-surface shadow-[var(--shadow-3)]',
          error: 'bg-error-container text-on-error-container',
          actionButton:
            'ui-focus ml-auto cursor-pointer rounded-sm px-2 py-1 font-semibold text-inverse-primary',
          closeButton: 'ui-focus cursor-pointer rounded-full',
        },
      }}
    />
  )
}
