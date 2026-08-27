import { Toaster as SonnerToaster, toast } from 'sonner'

export { toast }

/**
 * 状态反馈条：排队、计时、滑动关闭与 aria-live 由 sonner 接管，这里只给契约外观。
 *
 * unstyled 关掉 sonner 自带皮肤，全部走 classNames；停留时长按契约 4s，
 * 带 action 的那条由调用方传 duration 改成 8s。整个应用只挂一次。
 */
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
