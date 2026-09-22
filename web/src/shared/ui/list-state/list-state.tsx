/** 列表页共用的四个状态块：读取中、读取失败、空列表与「加载更多」页脚。只管长相，何时显示由调用方定。 */

import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export function ListPending({ label }: { label: string }) {
  return (
    <p
      className="flex items-center justify-center gap-2 py-16 text-body text-on-surface-variant"
      role="status"
    >
      <Icon className="animate-spin" decorative name="loading" size="sm" />
      {label}
    </p>
  )
}

export function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16" role="alert">
      <p className="text-body text-error">{message}</p>
      <Button leadingIcon="refresh" onClick={onRetry} size="md" variant="outlined">
        重新加载
      </Button>
    </div>
  )
}

/** 给了 icon 就在文字前放一个主色图标，如「没有异常」前的对勾。 */
export function ListEmpty({ children, icon }: { children: ReactNode; icon?: IconName }) {
  if (icon === undefined) {
    return <p className="py-16 text-center text-body text-on-surface-variant">{children}</p>
  }
  return (
    <p className="flex items-center justify-center gap-2 py-16 text-body text-on-surface-variant">
      <Icon className="text-primary" decorative name={icon} size="sm" />
      {children}
    </p>
  )
}

type LoadMoreFooterProps = {
  /** 按钮文字，读取中时换成「正在读取…」。 */
  label: string
  isFetching: boolean
  onMore: () => void
  /** 给了 shown 就在左侧写已显示几条；total 未知时只写已显示。 */
  shown?: number | undefined
  total?: number | undefined
}

export function LoadMoreFooter({ label, isFetching, onMore, shown, total }: LoadMoreFooterProps) {
  const counter =
    shown === undefined
      ? null
      : total === undefined
        ? `已显示 ${shown}`
        : `已显示 ${shown} / ${total}`
  return (
    <footer
      className={cn(
        'flex items-center px-3 py-4',
        counter === null
          ? 'justify-center'
          : 'justify-between gap-4 text-body text-on-surface-variant',
      )}
    >
      {counter === null ? null : <span>{counter}</span>}
      <Button disabled={isFetching} leadingIcon="expand" onClick={onMore} size="md" variant="ghost">
        {isFetching ? '正在读取…' : label}
      </Button>
    </footer>
  )
}
