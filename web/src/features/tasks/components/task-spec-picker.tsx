/**
 * 出片参数的下拉：允许自由输入、按 value 匹配已有选项、弹层自己锚在输入框上。
 * 这三条和 shared/ui/search-list 的「按 id 选一个候选」不是一回事，所以不并进去。
 */

import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { MAX_SHORT_TEXT_CHARS } from '../task-limits'

type TaskSpecPickerProps = {
  label: string
  options: readonly { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
  disabled: boolean
  placeholder?: string
  allowCustom?: boolean
}

const CONTROL =
  'task-form-control flex h-(--control-height-md) w-full min-w-0 items-center gap-1 rounded-sm border border-transparent bg-surface-container-low px-3 text-body text-on-surface focus-within:border-primary focus-within:bg-surface-container-lowest'

/** 规格字段既可选建议值也可自由填写；已知显示名回写原有合同值。 */
export function TaskSpecPicker({
  label,
  options,
  value,
  onChange,
  disabled,
  placeholder = '选择或输入',
  allowCustom = false,
}: TaskSpecPickerProps) {
  const id = useId()
  const listId = `${id}-options`
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const expanded = open && !disabled
  const selected = options.find((option) => option.value === value)
  const displayValue = selected?.label ?? value
  const search = query.toLocaleLowerCase()
  const matches = options.filter(
    (option) =>
      option.label.toLocaleLowerCase().includes(search) ||
      option.value.toLocaleLowerCase().includes(search),
  )
  const activeOption = matches[activeIndex]

  const changeOpen = (next: boolean) => {
    setOpen(next && !disabled)
    setQuery('')
    setActiveIndex(-1)
  }
  const select = (next: string) => {
    onChange(next)
    changeOpen(false)
  }
  const moveTo = (index: number) => {
    setActiveIndex(index)
    listRef.current?.children.item(index)?.scrollIntoView({ block: 'nearest' })
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey)
      return
    if (event.key === 'Tab') {
      changeOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (matches.length) {
        moveTo(
          event.key === 'ArrowDown'
            ? (activeIndex + 1) % matches.length
            : (activeIndex > 0 ? activeIndex : matches.length) - 1,
        )
      }
    } else if (expanded && event.key === 'Enter') {
      // 自由输入已经同步到表单；没有活动项时只收起，避免误提交整个需求单。
      event.preventDefault()
      if (activeOption) select(activeOption.value)
      else changeOpen(false)
    } else if (expanded && (event.key === 'Home' || event.key === 'End') && !allowCustom) {
      event.preventDefault()
      moveTo(event.key === 'Home' ? 0 : matches.length - 1)
    }
  }
  const comboboxProps = {
    'aria-activedescendant': expanded && activeOption ? `${listId}-${activeIndex}` : undefined,
    'aria-controls': expanded ? listId : undefined,
    'aria-expanded': expanded,
    'aria-haspopup': 'listbox' as const,
    'aria-label': label,
    disabled,
    id,
    onKeyDown: handleKeyDown,
    role: 'combobox',
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="text-body-sm font-medium text-on-surface-variant" htmlFor={id}>
        {label}
      </label>
      <PopupRoot open={expanded} onOpenChange={changeOpen}>
        <PopupAnchor asChild>
          {allowCustom ? (
            <div
              className={cn(
                CONTROL,
                disabled && 'border-border bg-transparent text-on-surface-variant',
              )}
            >
              <Input
                {...comboboxProps}
                aria-autocomplete="list"
                autoComplete="off"
                className="field-nested-input h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 disabled:text-on-surface-variant"
                maxLength={MAX_SHORT_TEXT_CHARS}
                onChange={(event) => {
                  const next = event.target.value
                  setQuery(next)
                  setActiveIndex(-1)
                  setOpen(true)
                  onChange(options.find((option) => option.label === next)?.value ?? next)
                }}
                onClick={() => changeOpen(true)}
                placeholder={placeholder}
                ref={inputRef}
                value={displayValue}
              />
              {value && !disabled ? (
                <IconButton
                  className="shrink-0"
                  label={`清空${label}`}
                  name="close"
                  onClick={() => {
                    onChange('')
                    setQuery('')
                    setActiveIndex(-1)
                    inputRef.current?.focus()
                  }}
                  onPointerDown={(event) => event.preventDefault()}
                  size="xs"
                  tabIndex={-1}
                />
              ) : null}
              <IconButton
                className="-mr-1 shrink-0"
                disabled={disabled}
                label={`${expanded ? '收起' : '展开'}${label}选项`}
                name={expanded ? 'collapse' : 'expand'}
                onClick={() => {
                  inputRef.current?.focus()
                  changeOpen(!expanded)
                }}
                onPointerDown={(event) => event.preventDefault()}
                size="xs"
                tabIndex={-1}
              />
            </div>
          ) : (
            <button
              {...comboboxProps}
              className={cn(
                CONTROL,
                'ui-state cursor-pointer ui-focus-inline disabled:cursor-default',
              )}
              onClick={() => changeOpen(!expanded)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {displayValue || placeholder}
              </span>
              <Icon
                className="shrink-0 text-on-surface-variant"
                decorative
                name={expanded ? 'collapse' : 'expand'}
                size="sm"
              />
            </button>
          )}
        </PopupAnchor>
        <PopupSurface
          align="start"
          aria-label={`${label}选项`}
          className="w-(--radix-popover-trigger-width) min-w-(--radix-popover-trigger-width) overflow-hidden rounded-md p-1.5"
          collisionPadding={12}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            changeOpen(false)
          }}
          onInteractOutside={(event) => {
            // 输入框是弹层的锚点；继续编辑或点击箭头由字段自己处理。
            if (
              event.target instanceof Node &&
              inputRef.current?.parentElement?.contains(event.target)
            )
              event.preventDefault()
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          sideOffset={6}
        >
          <div
            aria-label={label}
            className="max-h-60 overflow-y-auto overscroll-contain"
            id={listId}
            ref={listRef}
            role="listbox"
          >
            {matches.map((option, index) => (
              <button
                aria-selected={option.value === value}
                className={cn(
                  'flex min-h-10 w-full ui-state cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-left text-body ui-focus',
                  option.value === value && 'bg-state-active text-primary',
                  activeIndex === index && 'bg-state-focus',
                )}
                id={`${listId}-${index}`}
                key={option.value}
                onClick={() => select(option.value)}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActiveIndex(index)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="min-w-0 flex-1 break-words">{option.label}</span>
                {option.value === value ? (
                  <Icon className="shrink-0 text-primary" decorative name="check" size="sm" />
                ) : null}
              </button>
            ))}
          </div>
          {!matches.length ? (
            <p className="px-3 py-2 text-body-sm text-on-surface-variant" role="status">
              {allowCustom ? '将使用当前输入' : '暂无可选项'}
            </p>
          ) : null}
        </PopupSurface>
      </PopupRoot>
    </div>
  )
}
