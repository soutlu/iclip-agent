/** 一条筛选条上的几个弹层：同时只开一个，关掉的那个把焦点还给自己的触发器。条上有哪些条件由调用方决定。 */

import { createContext, use, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'

type FilterBarContextValue = {
  openFilter: string | null
  setOpen: (id: string, open: boolean) => void
  triggerRef: (id: string) => RefObject<HTMLButtonElement | null>
  close: () => void
}

const FilterBarContext = createContext<FilterBarContextValue | null>(null)

/** 条上的组件与调用方都经它取用开合状态；写条件的 `apply` 先 `close()` 再回调。 */
export function useFilterBar(): FilterBarContextValue {
  const context = use(FilterBarContext)
  if (context === null) throw new Error('FilterPopup 必须放在 FilterBarRoot 内')
  return context
}

/** 持有当前展开的筛选与各触发器的 ref；自身只是一个横向容器，间距与底色由调用方给。 */
export function FilterBarRoot({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
}) {
  const [openFilter, setOpenFilter] = useState<string | null>(null)
  const triggersRef = useRef(new Map<string, RefObject<HTMLButtonElement | null>>())

  const triggerRef = (id: string): RefObject<HTMLButtonElement | null> => {
    const existing = triggersRef.current.get(id)
    if (existing) return existing
    const createdRef: RefObject<HTMLButtonElement | null> = { current: null }
    triggersRef.current.set(id, createdRef)
    return createdRef
  }

  return (
    <FilterBarContext
      value={{
        openFilter,
        setOpen: (id, open) => {
          // 切换触发器时，旧弹层的关闭事件不能清掉刚打开的新弹层。
          setOpenFilter((current) => (open ? id : current === id ? null : current))
        },
        triggerRef,
        close: () => {
          // 在移除选择器前归还焦点，避免活动元素随草稿一起卸载后落到页面 body。
          if (openFilter !== null) triggersRef.current.get(openFilter)?.current?.focus()
          setOpenFilter(null)
        },
      }}
    >
      <div className={cn('flex flex-wrap items-center', className)}>{children}</div>
    </FilterBarContext>
  )
}

type FilterPopupProps = {
  /** 条内唯一，用来互斥开合与认领触发器。 */
  id: string
  icon: IconName
  /** 触发器上的可见文字。 */
  label: string
  /** 触发器的可访问名；不给就用 label。 */
  triggerLabel?: string | undefined
  /** 弹层的可访问名。 */
  popupLabel: string
  /** 已应用非默认条件：只改文字颜色，不改底色。 */
  selected: boolean
  disabled?: boolean | undefined
  /** 触发器的悬浮说明；不给就用 label。 */
  title?: string | undefined
  align?: 'start' | 'end'
  /** 弹层宽度等外观类。 */
  width: string
  /** 触发器外观类，各条筛选条给自己的。 */
  className?: string | undefined
  children: ReactNode
}

/** 触发器加一层弹层；内容只在展开时挂载，收起时选择器里的搜索词与临时日期一并丢弃。 */
export function FilterPopup({
  align = 'start',
  children,
  className,
  disabled,
  icon,
  id,
  label,
  popupLabel,
  selected,
  title,
  triggerLabel,
  width,
}: FilterPopupProps) {
  const { openFilter, setOpen, triggerRef } = useFilterBar()
  const open = openFilter === id

  return (
    <PopupRoot onOpenChange={(next) => setOpen(id, next)} open={open}>
      <PopupTrigger asChild>
        <button
          aria-label={triggerLabel ?? label}
          className={cn(
            'inline-flex min-w-0 ui-state cursor-pointer items-center gap-2 text-body text-on-surface ui-focus data-[state=open]:bg-state-active',
            // 主色文字只表示「已应用非默认条件」，展开态与选中底都走中性状态层。
            selected && 'text-primary',
            className,
          )}
          disabled={disabled}
          ref={triggerRef(id)}
          title={title ?? label}
          type="button"
        >
          <Icon decorative name={icon} size="sm" />
          <span className="max-w-44 truncate">{label}</span>
          <Icon className="text-on-surface-variant" decorative name="expand" size="xs" />
        </button>
      </PopupTrigger>
      <PopupSurface
        align={align}
        aria-label={popupLabel}
        className={width}
        collisionPadding={12}
        showArrow
        sideOffset={6}
      >
        {open ? children : null}
      </PopupSurface>
    </PopupRoot>
  )
}
