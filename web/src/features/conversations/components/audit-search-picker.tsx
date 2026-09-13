import {
  SearchListInput,
  SearchListOptionContent,
  SearchListOptions,
  SearchListRoot,
  SearchListStatus,
  type SearchListOption,
  type SearchListOptionState,
} from '@/shared/ui/search-list'

type AuditSearchPickerProps = {
  options: readonly SearchListOption[]
  value: string | null
  /** 当前已选项移出候选时继续显示的名称。 */
  selectedLabel?: string | undefined
  onChange: (value: string | null) => void
  /** 候选的名词，用于搜索框、列表与状态文案。 */
  label: string
  withAvatars?: boolean
  isPending?: boolean
  error?: string | undefined
  onRetry?: (() => void) | undefined
}

/** 治理者筛选用的单选搜索列表：再次选择当前项即清除条件，弹层开关由外层管理。 */
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
  // 候选刷新或移除后，已生效的条件仍需有一个可再次选择的清除入口。
  const choices =
    value !== null && !options.some((option) => option.id === value)
      ? [{ id: value, label: selectedLabel?.trim() || `已选${label}` }, ...options]
      : options

  return (
    <SearchListRoot
      className="p-2.5"
      error={error}
      onSelect={(id) => onChange(id === value ? null : id)}
      options={choices}
      pending={isPending}
      value={value}
    >
      <SearchListInput label={`搜索${label}`} />
      <SearchListOptions
        label={label}
        renderOption={withAvatars ? renderOptionWithAvatar : undefined}
      />
      <SearchListStatus label={label} onRetry={onRetry} />
    </SearchListRoot>
  )
}

const renderOptionWithAvatar = (option: SearchListOption, { selected }: SearchListOptionState) => (
  <SearchListOptionContent
    leading={
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-label"
      >
        {Array.from(option.label.trim())[0]?.toLocaleUpperCase()}
      </span>
    }
    option={option}
    selected={selected}
  />
)
