import { useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import {
  SearchListInput,
  SearchListOptionContent,
  SearchListOptions,
  SearchListRoot,
  SearchListStatus,
  useSearchList,
  type SearchListOption,
  type SearchListOptionState,
} from '@/shared/ui/search-list'

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
  const openingDialogRef = useRef(false)
  const selected = options.find((option) => option.id === value)
  // 当前合集置顶，其余保持接口给的最近更新顺序。
  const choices = [
    ...(selected ? [selected] : []),
    ...options.filter((option) => option.id !== value),
  ].map((option) => ({ id: option.id, label: option.name }))

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
      sideOffset={8}
      side="bottom"
    >
      <SearchListRoot
        disabled={disabled}
        error={error ?? undefined}
        onSelect={onChange}
        options={choices}
        pending={loading}
        value={value}
      >
        <h2 className="px-1 pt-1 text-body-sm font-semibold">关联合集</h2>
        <SearchListInput
          label="搜索合集"
          trailingAction={<ClearSearchButton disabled={disabled} />}
        />
        <SearchListOptions label="合集" renderOption={renderCollectionOption} />
        <SearchListStatus
          label="合集"
          onRetry={onRetry}
          renderEmpty={(query) => <EmptyHint canCreate={onCreate !== undefined} query={query} />}
        />
        <PickerFooter
          disabled={disabled}
          onClear={() => onChange(null)}
          onCreate={
            onCreate
              ? (name) => {
                  openingDialogRef.current = true
                  onCreate(name)
                }
              : undefined
          }
          unassigned={value === null}
        />
      </SearchListRoot>
    </PopupSurface>
  )
}

const renderCollectionOption = (option: SearchListOption, { selected }: SearchListOptionState) => (
  <SearchListOptionContent
    leading={<Icon className="shrink-0" decorative name="folder" size="md" />}
    option={option}
    selected={selected}
  />
)

function ClearSearchButton({ disabled }: { disabled: boolean | undefined }) {
  const { query, setQuery, focusInput } = useSearchList()
  if (!query) return null
  return (
    <IconButton
      disabled={disabled}
      label="清空搜索"
      name="close"
      onClick={() => {
        setQuery('')
        focusInput()
      }}
      size="xs"
    />
  )
}

function EmptyHint({ canCreate, query }: { canCreate: boolean; query: string }) {
  return (
    <>
      <p className="text-body-sm text-on-surface">{query ? '没有找到相关合集' : '暂无可选合集'}</p>
      <p className="mt-2 text-caption">
        {query
          ? canCreate
            ? '试试其他名称，或新建一个合集'
            : '试试其他名称'
          : canCreate
            ? '新建一个合集，整理你的创作对话'
            : '你可以先不关联合集，直接开始创作'}
      </p>
    </>
  )
}

type PickerFooterProps = {
  disabled: boolean | undefined
  unassigned: boolean
  onClear: () => void
  onCreate: ((initialName: string) => void) | undefined
}

// 与共享列表的选项行同一尺寸，让页脚的图标与文字和上方选项对齐。
const FOOTER_ROW_CLASS =
  'flex min-h-10 w-full ui-state cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2.5 text-left text-body ui-focus disabled:cursor-not-allowed disabled:text-disabled-text'

/** 不关联与新建两个入口；新建把当前搜索词带进表单。 */
function PickerFooter({ disabled, unassigned, onClear, onCreate }: PickerFooterProps) {
  const { query } = useSearchList()
  const search = query.trim()
  return (
    <div className="shrink-0 border-t border-border pt-1">
      <button className={FOOTER_ROW_CLASS} disabled={disabled} onClick={onClear} type="button">
        <Icon decorative name="folder" size="md" />
        <span className="flex-1">不关联合集</span>
        {unassigned ? <Icon decorative name="check" size="md" /> : null}
      </button>
      {onCreate ? (
        <button
          className={cn(FOOTER_ROW_CLASS, 'text-primary')}
          disabled={disabled}
          onClick={() => onCreate(search)}
          title={search ? `新建“${search}”` : undefined}
          type="button"
        >
          <Icon className="shrink-0" decorative name="add" size="md" />
          <span className="truncate">{search ? `新建“${search}”` : '新建合集'}</span>
        </button>
      ) : null}
    </div>
  )
}
