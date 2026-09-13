/** 带搜索框的单选列表：过滤、活动项、键盘与 ARIA 在这里；候选顺序、行内容和选中语义由调用方组合。 */

import {
  createContext,
  use,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'

export type SearchListOption = { id: string; label: string }

type SearchListContextValue = {
  matches: readonly SearchListOption[]
  query: string
  changeQuery: (query: string) => void
  value: string | null
  activeId: string | null
  setActiveId: (id: string | null) => void
  disabled: boolean
  pending: boolean
  error: string | undefined
  listId: string
  listRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  select: (id: string) => void
  focusInput: () => void
  handleInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

const SearchListContext = createContext<SearchListContextValue | null>(null)

const useSearchListContext = (): SearchListContextValue => {
  const context = use(SearchListContext)
  if (context === null) throw new Error('SearchList 的子组件必须放在 SearchListRoot 内')
  return context
}

const OPTION_CLASS =
  'flex min-h-10 w-full ui-state cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2.5 text-left text-body text-on-surface ui-focus disabled:cursor-not-allowed disabled:text-disabled-text'

type SearchListRootProps = {
  options: readonly SearchListOption[]
  value: string | null
  /** 点击或 Enter 选中某项；再次选中已选项是否清除由调用方决定。 */
  onSelect: (id: string) => void
  disabled?: boolean | undefined
  /** 首次加载中：列表标 aria-busy，状态区显示加载文案。 */
  pending?: boolean | undefined
  /** 读取失败原因；有缓存候选时与列表并存。 */
  error?: string | undefined
  className?: string | undefined
  children: ReactNode
}

/** 持有搜索词、匹配项、活动项与键盘处理，子组件通过 context 取用；自身只是一个纵向容器。 */
export function SearchListRoot({
  options,
  value,
  onSelect,
  disabled = false,
  pending = false,
  error,
  className,
  children,
}: SearchListRootProps) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const search = query.trim().toLocaleLowerCase()
  const matches = options.filter((option) => option.label.toLocaleLowerCase().includes(search))
  const activeIndex = matches.findIndex((option) => option.id === activeId)
  const activeOption = matches[activeIndex]

  const changeQuery = (next: string) => {
    setQuery(next)
    setActiveId(null)
  }
  const focusInput = () => inputRef.current?.focus()
  const moveTo = (index: number) => {
    const option = matches[index]
    if (!option) return
    setActiveId(option.id)
    listRef.current?.children.item(index)?.scrollIntoView({ block: 'nearest' })
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 保留输入法确认和系统编辑快捷键，避免把输入操作当成选择。
    if (
      disabled ||
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
          onSelect(activeOption.id)
        }
        break
    }
  }

  return (
    <SearchListContext
      value={{
        matches,
        query,
        changeQuery,
        value,
        activeId,
        setActiveId,
        disabled,
        pending,
        error,
        listId,
        listRef,
        inputRef,
        select: onSelect,
        focusInput,
        handleInputKeyDown,
      }}
    >
      <div className={cn('flex flex-col gap-2 text-on-surface', className)}>{children}</div>
    </SearchListContext>
  )
}

/** 调用方在 Root 内读写搜索词，例如清空按钮或「新建“{query}”」页脚。 */
export function useSearchList(): {
  query: string
  setQuery: (query: string) => void
  focusInput: () => void
} {
  const { query, changeQuery, focusInput } = useSearchListContext()
  return { query, setQuery: changeQuery, focusInput }
}

type SearchListInputProps = {
  /** 搜索框的可访问名与占位文案。 */
  label: string
  trailingAction?: ReactNode
  wrapperClassName?: string | undefined
}

/** combobox 角色的搜索框：键盘事件交给 Root，活动项通过 aria-activedescendant 暴露。 */
export function SearchListInput({ label, trailingAction, wrapperClassName }: SearchListInputProps) {
  const { matches, query, changeQuery, activeId, disabled, listId, inputRef, handleInputKeyDown } =
    useSearchListContext()
  const activeOption = matches.find((option) => option.id === activeId)
  return (
    <Input
      aria-activedescendant={activeOption ? optionDomId(listId, activeOption.id) : undefined}
      aria-autocomplete="list"
      aria-controls={listId}
      aria-expanded
      aria-label={label}
      autoComplete="off"
      className="text-body"
      disabled={disabled}
      leadingIcon="search"
      onChange={(event) => changeQuery(event.target.value)}
      onKeyDown={handleInputKeyDown}
      placeholder={label}
      ref={inputRef}
      role="combobox"
      trailingAction={trailingAction}
      value={query}
      wrapperClassName={cn(
        'h-10 shrink-0 rounded-sm border-transparent bg-surface-container-low px-3',
        wrapperClassName,
      )}
    />
  )
}

export type SearchListOptionState = { selected: boolean; active: boolean }

type SearchListOptionsProps = {
  /** 列表的可访问名。 */
  label: string
  className?: string | undefined
  /** 行内容；默认为高亮命中的名称加已选对勾。 */
  renderOption?: ((option: SearchListOption, state: SearchListOptionState) => ReactNode) | undefined
}

/** 匹配项的 listbox：选项不进 Tab 序列，点击与悬停都不抢搜索框的焦点。 */
export function SearchListOptions({
  label,
  className,
  renderOption = (option, { selected }) => (
    <SearchListOptionContent option={option} selected={selected} />
  ),
}: SearchListOptionsProps) {
  const { matches, value, activeId, setActiveId, disabled, pending, listId, listRef, select } =
    useSearchListContext()
  return (
    <div
      aria-busy={pending}
      aria-label={label}
      // 列表自己限高滚动，不随外层弹层的高度上限收缩，否则受限空间里选项会被裁掉。
      className={cn('max-h-72 shrink-0 overflow-y-auto overscroll-contain', className)}
      id={listId}
      ref={listRef}
      role="listbox"
    >
      {matches.map((option) => {
        const selected = option.id === value
        const active = option.id === activeId
        return (
          <button
            aria-selected={selected}
            className={cn(
              OPTION_CLASS,
              selected && 'bg-state-active',
              // 活动项写在选中态之后，键盘停在已选行时仍能看出焦点位置。
              active && 'bg-state-focus',
            )}
            disabled={disabled}
            id={optionDomId(listId, option.id)}
            key={option.id}
            onClick={() => select(option.id)}
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
            {renderOption(option, { selected, active })}
          </button>
        )
      })}
    </div>
  )
}

type SearchListOptionContentProps = {
  option: SearchListOption
  selected: boolean
  /** 名称前的图标或头像。 */
  leading?: ReactNode
}

/** 默认行内容：可选前缀、高亮命中的名称、已选对勾。 */
export function SearchListOptionContent({
  option,
  selected,
  leading,
}: SearchListOptionContentProps) {
  return (
    <>
      {leading}
      <span className="min-w-0 flex-1 truncate">
        <HighlightedLabel text={option.label} />
      </span>
      {selected ? (
        <Icon className="shrink-0 text-primary" decorative name="check" size="sm" />
      ) : null}
    </>
  )
}

function HighlightedLabel({ text }: { text: string }) {
  const { query } = useSearchListContext()
  const search = query.trim()
  const start = search ? text.toLocaleLowerCase().indexOf(search.toLocaleLowerCase()) : -1
  if (start < 0) return text
  return (
    <>
      {text.slice(0, start)}
      <span className="font-medium text-primary">{text.slice(start, start + search.length)}</span>
      {text.slice(start + search.length)}
    </>
  )
}

type SearchListStatusProps = {
  /** 候选的名词，用于加载与空态文案。 */
  label: string
  onRetry?: (() => void) | undefined
  /** 自定义空态内容，收到去掉首尾空白的搜索词。 */
  renderEmpty?: ((query: string) => ReactNode) | undefined
}

/** 加载、失败与空态三选一；有候选且无异常时不渲染。 */
export function SearchListStatus({ label, onRetry, renderEmpty }: SearchListStatusProps) {
  const { matches, query, pending, error, disabled, focusInput } = useSearchListContext()
  if (pending) {
    return (
      <p className="px-3 py-6 text-center text-body-sm text-on-surface-variant" role="status">
        正在加载{label}…
      </p>
    )
  }
  if (error) {
    return (
      <div className="px-3 py-5 text-center">
        <p className="text-body-sm text-error" role="alert">
          {error}
        </p>
        {onRetry ? (
          <Button
            className="mt-2 text-primary"
            disabled={disabled}
            onClick={() => {
              onRetry()
              focusInput()
            }}
            size="md"
            variant="ghost"
          >
            重新加载
          </Button>
        ) : null}
      </div>
    )
  }
  if (matches.length) return null
  const search = query.trim()
  return (
    <div className="px-3 py-6 text-center text-body-sm text-on-surface-variant" role="status">
      {renderEmpty ? renderEmpty(search) : search ? `未找到匹配的${label}` : `暂无可选${label}`}
    </div>
  )
}

const optionDomId = (listId: string, optionId: string) => `${listId}-${optionId}`
