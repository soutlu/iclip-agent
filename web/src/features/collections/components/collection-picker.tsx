import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'

export type CollectionOption = { id: string; name: string }

type CollectionPickerProps = {
  disabled?: boolean | undefined
  error?: string | null | undefined
  loading?: boolean | undefined
  onChange: (id: string | null) => void
  onCreate?: ((initialName: string) => void) | undefined
  onRetry?: (() => void) | undefined
  options: readonly CollectionOption[]
  value: string | null
}

/** 选择和搜索仅作用于调用方提供的列表；合集的读写由外层负责。 */
export function CollectionPicker({
  disabled = false,
  error,
  loading = false,
  onChange,
  onCreate,
  onRetry,
  options,
  value,
}: CollectionPickerProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = options.find((option) => option.id === value)

  return (
    <div className="mx-3 -mt-3 rounded-b-xl bg-surface-container-low px-3 pt-4 pb-2">
      <PopupRoot open={open} onOpenChange={setOpen}>
        <PopupTrigger asChild>
          <button
            aria-label={`关联合集：${selected?.name ?? '未关联合集'}`}
            className="inline-flex max-w-full ui-state items-center gap-1.5 rounded-sm px-1 py-1 text-body-sm text-on-surface-variant ui-focus disabled:cursor-not-allowed disabled:text-disabled-text"
            disabled={disabled}
            ref={triggerRef}
            title={selected?.name}
            type="button"
          >
            <Icon decorative name="folder" size="sm" />
            <span className="min-w-0 truncate">{selected?.name ?? '未关联合集'}</span>
            <Icon decorative name={open ? 'collapse' : 'expand'} size="sm" />
          </button>
        </PopupTrigger>
        {open ? (
          <PickerContent
            disabled={disabled}
            error={error}
            loading={loading}
            onChange={(id) => {
              onChange(id)
              setOpen(false)
            }}
            onCreate={
              onCreate
                ? (name) => {
                    // 弹窗记住稳定的返回目标，不能记住即将卸载的“新建合集”按钮。
                    triggerRef.current?.focus()
                    setOpen(false)
                    onCreate(name)
                  }
                : undefined
            }
            options={options}
            onRetry={onRetry}
            value={value}
          />
        ) : null}
      </PopupRoot>
    </div>
  )
}

function PickerContent({
  disabled,
  error,
  loading,
  onChange,
  onCreate,
  onRetry,
  options,
  value,
}: CollectionPickerProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const openingDialogRef = useRef(false)
  const listId = useId()
  const search = query.trim()
  const selected = options.find((option) => option.id === value)
  const matches = search
    ? options.filter((option) =>
        option.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      )
    : [...(selected ? [selected] : []), ...options.filter((option) => option.id !== value)]
  const activeOption = matches[activeIndex]

  const moveTo = (index: number) => {
    setActiveIndex(index)
    listRef.current
      ?.querySelectorAll('[role="option"]')
      [index]?.scrollIntoView({ block: 'nearest' })
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || event.nativeEvent.isComposing || !matches.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next =
        event.key === 'ArrowDown'
          ? (activeIndex + 1) % matches.length
          : (activeIndex <= 0 ? matches.length : activeIndex) - 1
      moveTo(next)
    } else if (event.key === 'Enter' && activeOption) {
      event.preventDefault()
      onChange(activeOption.id)
    }
  }

  return (
    <PopupSurface
      align="start"
      aria-label="关联合集"
      avoidCollisions={false}
      className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-32px)] flex-col overflow-y-auto overscroll-contain p-2 text-on-surface"
      onCloseAutoFocus={(event) => {
        // 新建弹窗接管焦点，避免弹层关闭时又把焦点移回选择器。
        if (openingDialogRef.current) event.preventDefault()
      }}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        inputRef.current?.focus()
      }}
      sideOffset={8}
      side="bottom"
    >
      <div className="shrink-0 px-1 pt-1 pb-2">
        <h2 className="mb-3 text-body-sm font-semibold">关联合集</h2>
        <Input
          aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded
          aria-label="搜索合集"
          disabled={disabled}
          leadingIcon="search"
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(-1)
          }}
          onKeyDown={handleKeyDown}
          placeholder="搜索合集"
          ref={inputRef}
          role="combobox"
          trailingAction={
            query ? (
              <IconButton
                disabled={disabled}
                label="清空搜索"
                name="close"
                onClick={() => {
                  setQuery('')
                  setActiveIndex(-1)
                  inputRef.current?.focus()
                }}
                size="xs"
              />
            ) : null
          }
          value={query}
          wrapperClassName="h-(--control-height-md) rounded-sm px-2.5"
        />
      </div>
      <div className="max-h-72 shrink-0 overflow-y-auto overscroll-contain" ref={listRef}>
        {loading ? (
          <p className="px-3 py-9 text-center text-body-sm text-on-surface-variant" role="status">
            正在加载合集…
          </p>
        ) : error ? (
          <div className="px-3 py-6 text-center">
            <p className="text-body-sm text-error" role="alert">
              {error}
            </p>
            {onRetry ? (
              <button
                className="mt-2 ui-state rounded-sm px-3 py-1.5 text-body-sm text-primary ui-focus disabled:cursor-not-allowed disabled:text-disabled-text"
                disabled={disabled}
                onClick={onRetry}
                type="button"
              >
                重新加载
              </button>
            ) : null}
          </div>
        ) : null}
        <div aria-busy={loading} aria-label="合集" id={listId} role="listbox">
          {matches.map((option, index) => (
            <div key={option.id} role="presentation">
              {!search && ((selected && index === 1) || (!selected && index === 0)) ? (
                <p className="px-2 pt-2 pb-1 text-caption text-on-surface-variant">最近更新</p>
              ) : null}
              <button
                aria-selected={option.id === value}
                className={cn(
                  'flex h-10 w-full ui-state items-center gap-2.5 rounded-sm px-2 text-left text-body-sm ui-focus disabled:cursor-not-allowed disabled:text-disabled-text',
                  option.id === value && 'bg-primary-container/50 text-on-primary-container',
                  index === activeIndex && 'bg-surface-container-high',
                )}
                id={`${listId}-${option.id}`}
                disabled={disabled}
                onClick={() => onChange(option.id)}
                role="option"
                tabIndex={-1}
                title={option.name}
                type="button"
              >
                <Icon className="shrink-0" decorative name="folder" size="md" />
                <span className="min-w-0 flex-1 truncate">
                  <MatchedName name={option.name} search={search} />
                </span>
                {option.id === value ? (
                  <Icon className="shrink-0 text-primary" decorative name="check" size="md" />
                ) : null}
              </button>
            </div>
          ))}
        </div>
        {!loading && !error && !matches.length ? (
          <div className="px-3 py-9 text-center" role="status">
            <p className="text-body-sm">{search ? '没有找到相关合集' : '暂无可选合集'}</p>
            <p className="mt-2 text-caption text-on-surface-variant">
              {search
                ? onCreate
                  ? '试试其他名称，或新建一个合集'
                  : '试试其他名称'
                : onCreate
                  ? '新建一个合集，整理你的创作对话'
                  : '你可以先不关联合集，直接开始创作'}
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-2 shrink-0 border-t border-border pt-1">
        <button
          className="flex h-10 w-full ui-state items-center gap-2.5 rounded-sm px-2 text-left text-body-sm ui-focus disabled:cursor-not-allowed disabled:text-disabled-text"
          disabled={disabled}
          onClick={() => onChange(null)}
          type="button"
        >
          <Icon decorative name="folder" size="md" />
          <span className="flex-1">不关联合集</span>
          {value === null ? <Icon decorative name="check" size="md" /> : null}
        </button>
        {onCreate ? (
          <button
            className="flex h-10 w-full ui-state items-center gap-2.5 rounded-sm px-2 text-left text-body-sm text-primary ui-focus disabled:cursor-not-allowed disabled:text-disabled-text"
            disabled={disabled}
            onClick={() => {
              openingDialogRef.current = true
              onCreate(search)
            }}
            title={search ? `新建“${search}”` : undefined}
            type="button"
          >
            <Icon className="shrink-0" decorative name="add" size="md" />
            <span className="truncate">{search ? `新建“${search}”` : '新建合集'}</span>
          </button>
        ) : null}
      </div>
    </PopupSurface>
  )
}

function MatchedName({ name, search }: { name: string; search: string }) {
  const start = name.toLocaleLowerCase().indexOf(search.toLocaleLowerCase())
  if (!search || start < 0) return name
  return (
    <>
      {name.slice(0, start)}
      <span className="font-medium text-primary">{name.slice(start, start + search.length)}</span>
      {name.slice(start + search.length)}
    </>
  )
}
