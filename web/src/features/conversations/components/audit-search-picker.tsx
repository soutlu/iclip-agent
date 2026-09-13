import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'

type AuditSearchPickerProps = {
  options: readonly { id: string; label: string }[]
  value: string | null
  /** 当前已选项移出候选时继续显示的名称。 */
  selectedLabel?: string | undefined
  onChange: (value: string | null) => void
  label: '用户' | '需求单'
  withAvatars?: boolean
  isPending?: boolean
  error?: string | undefined
  onRetry?: (() => void) | undefined
}

/** 在调用方提供的候选内搜索；再次选择当前项会清除筛选，弹层开关由外层管理。 */
export function AuditSearchPicker({
  options,
  value,
  selectedLabel,
  onChange,
  label,
  withAvatars = false,
  isPending = false,
  error,
  onRetry,
}: AuditSearchPickerProps) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const search = query.trim().toLocaleLowerCase()
  // 候选刷新或移除后，已生效的条件仍需有一个可再次选择的清除入口。
  const choices =
    value !== null && !options.some((option) => option.id === value)
      ? [{ id: value, label: selectedLabel?.trim() || `已选${label}` }, ...options]
      : options
  const matches = choices.filter((option) => option.label.toLocaleLowerCase().includes(search))
  const activeIndex = matches.findIndex((option) => option.id === activeId)
  const activeOption = matches[activeIndex]

  const selectOption = (id: string) => onChange(id === value ? null : id)
  const moveTo = (index: number) => {
    const option = matches[index]
    if (!option) return
    setActiveId(option.id)
    listRef.current?.children.item(index)?.scrollIntoView({ block: 'nearest' })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 保留输入法确认和系统编辑快捷键，避免把输入操作当成选择。
    if (
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !matches.length
    )
      return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveTo((activeIndex + 1) % matches.length)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveTo((activeIndex > 0 ? activeIndex : matches.length) - 1)
        break
      case 'Home':
        event.preventDefault()
        moveTo(0)
        break
      case 'End':
        event.preventDefault()
        moveTo(matches.length - 1)
        break
      case 'Enter':
        if (activeOption) {
          event.preventDefault()
          selectOption(activeOption.id)
        }
        break
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 p-2.5 text-on-surface">
      <Input
        aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded
        aria-label={`搜索${label}`}
        autoComplete="off"
        className="text-body"
        leadingIcon="search"
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveId(null)
        }}
        onKeyDown={handleKeyDown}
        placeholder={`搜索${label}`}
        ref={inputRef}
        role="combobox"
        value={query}
        wrapperClassName="h-10 shrink-0 rounded-sm border-transparent bg-surface-container-low px-3"
      />
      <div
        aria-busy={isPending}
        aria-label={label}
        className="max-h-72 min-h-0 overflow-y-auto overscroll-contain"
        id={listId}
        ref={listRef}
        role="listbox"
      >
        {matches.map((option) => {
          const selected = option.id === value
          return (
            <button
              aria-selected={selected}
              className={cn(
                'flex min-h-10 w-full ui-state cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2.5 text-left text-body ui-focus',
                option.id === activeId && 'bg-state-focus',
                selected && 'bg-primary/8',
              )}
              id={`${listId}-${option.id}`}
              key={option.id}
              onClick={() => selectOption(option.id)}
              onPointerDown={(event) => {
                // 焦点始终留在搜索框，活动项通过 aria-activedescendant 告知辅助技术。
                if (event.button === 0) event.preventDefault()
              }}
              onPointerMove={() => setActiveId(option.id)}
              role="option"
              tabIndex={-1}
              title={option.label}
              type="button"
            >
              {withAvatars ? (
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-label',
                    selected && 'bg-primary-container/70 text-primary',
                  )}
                >
                  {Array.from(option.label.trim())[0]?.toLocaleUpperCase()}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected ? (
                <Icon className="shrink-0 text-primary" decorative name="check" size="sm" />
              ) : null}
            </button>
          )
        })}
      </div>
      {isPending ? (
        <p className="px-3 py-6 text-center text-body-sm text-on-surface-variant" role="status">
          正在加载{label}…
        </p>
      ) : error ? (
        <div className="px-3 py-5 text-center">
          <p className="text-body-sm text-error" role="alert">
            {error}
          </p>
          {onRetry ? (
            <Button
              className="mt-2 text-primary"
              onClick={() => {
                onRetry()
                inputRef.current?.focus()
              }}
              size="md"
              variant="ghost"
            >
              重新加载
            </Button>
          ) : null}
        </div>
      ) : !matches.length ? (
        <p className="px-3 py-6 text-center text-body-sm text-on-surface-variant" role="status">
          {search ? `未找到匹配的${label}` : `暂无可选${label}`}
        </p>
      ) : null}
    </div>
  )
}
