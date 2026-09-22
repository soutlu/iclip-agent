/** 筛选条上常见的两种弹层：搜索单选一个候选，或选一段时间范围。名词、宽度与触发器外观由各条筛选条给。 */

import type { IconName } from '@/shared/icons'
import type { DateRange } from '@/shared/lib/date-range'
import { DateRangePicker } from '@/shared/ui/date-range-picker'
import { SearchPicker, type PickerSource } from '@/shared/ui/search-picker'
import { FilterPopup } from './filter-bar'

type PickerFilterProps = {
  id: string
  icon: IconName
  /** 候选的名词：未选时的触发器文字，也是搜索框、弹层与状态文案里的叫法。 */
  noun: string
  /** 已选项不在候选里时显示的名字。 */
  fallbackLabel: string
  /** null 表示当前账号没有权限拿候选，触发器禁用并显示 disabledTitle。 */
  source: PickerSource | null
  value: string | null
  onChange: (value: string | null) => void
  width: string
  className?: string | undefined
  withAvatars?: boolean | undefined
  disabledTitle?: string | undefined
}

export function PickerFilter({
  id,
  icon,
  noun,
  fallbackLabel,
  source,
  value,
  onChange,
  width,
  className,
  withAvatars,
  disabledTitle,
}: PickerFilterProps) {
  const label =
    value === null
      ? noun
      : (source?.options.find((option) => option.id === value)?.label ?? fallbackLabel)
  return (
    <FilterPopup
      className={className}
      disabled={source === null}
      icon={icon}
      id={id}
      label={label}
      popupLabel={`选择${noun}`}
      selected={value !== null}
      title={source === null ? disabledTitle : label}
      triggerLabel={`${noun}：${label}`}
      width={width}
    >
      {source === null ? null : (
        <SearchPicker
          label={noun}
          onChange={onChange}
          selectedLabel={label}
          source={source}
          value={value}
          withAvatars={withAvatars ?? false}
        />
      )}
    </FilterPopup>
  )
}

type DateRangeFilterProps = {
  value: DateRange
  onChange: (value: DateRange) => void
  /** 触发器上的文字，如「建立时间：近 7 天」。 */
  label: string
  /** 触发器的可访问名；不给就用 label。 */
  triggerLabel?: string | undefined
  popupLabel: string
  align?: 'start' | 'end' | undefined
  className?: string | undefined
}

/** 弹层要装得下并排的两个月，宽度随内容走，只在窄屏受视口约束。 */
export function DateRangeFilter({
  value,
  onChange,
  label,
  triggerLabel,
  popupLabel,
  align,
  className,
}: DateRangeFilterProps) {
  return (
    <FilterPopup
      {...(align === undefined ? {} : { align })}
      className={className}
      icon="duration"
      id="time"
      label={label}
      popupLabel={popupLabel}
      selected={value.range !== 'all'}
      triggerLabel={triggerLabel}
      width="w-max max-w-[calc(100vw-24px)] rounded-lg"
    >
      <DateRangePicker onChange={onChange} value={value} />
    </FilterPopup>
  )
}
