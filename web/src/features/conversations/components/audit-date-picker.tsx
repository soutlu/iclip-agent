import { useId, useState } from 'react'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { auditDateLabel, formatLocalDate, parseLocalDate } from '../audit-dates'
import type { AuditFilters } from '../audit.api'
import { DateRangeCalendar } from './date-range-calendar'

type AuditDateValue = Pick<AuditFilters, 'range' | 'since' | 'until'>

type AuditDatePickerProps = {
  value: AuditDateValue
  /** 只交回可应用的范围；自定义只选一端时保持在组件内。 */
  onChange: (value: AuditDateValue) => void
}

const CLEARED_RANGE: AuditDateValue = { range: 'all', since: null, until: null }

/** 时间浮层内容：快捷范围即选即用，自定义范围选满两端后再应用。 */
export function AuditDatePicker({ value, onChange }: AuditDatePickerProps) {
  const appliedStart =
    value.range === 'custom' && value.since !== null ? parseLocalDate(value.since) : null
  const appliedEnd =
    value.range === 'custom' && value.until !== null ? parseLocalDate(value.until) : null
  const [editingCustom, setEditingCustom] = useState(false)
  const [draftStart, setDraftStart] = useState<Date | null>(null)
  const rangeDescriptionId = useId()
  const isCustom = editingCustom || value.range === 'custom'
  const activeRange = isCustom ? 'custom' : value.range
  const start = draftStart ?? appliedStart
  const end = draftStart === null ? appliedEnd : null
  const startKey = start === null ? null : formatLocalDate(start)
  const endKey = end === null ? null : formatLocalDate(end)

  const selectRange = (range: string) => {
    if (range === 'custom') {
      setEditingCustom(true)
      return
    }
    if (range === '7d' || range === '30d') {
      onChange(value.range === range ? CLEARED_RANGE : { range, since: null, until: null })
      return
    }
    if (range === '') {
      if (editingCustom && value.range !== 'custom') {
        setEditingCustom(false)
        setDraftStart(null)
      } else {
        onChange(CLEARED_RANGE)
      }
    }
  }

  const selectDay = (date: Date) => {
    if (draftStart === null) {
      setDraftStart(date)
      return
    }
    const [since, until] = date < draftStart ? [date, draftStart] : [draftStart, date]
    onChange({ range: 'custom', since: formatLocalDate(since), until: formatLocalDate(until) })
  }

  const rangeDescription =
    start === null
      ? '选择开始日期'
      : end === null
        ? `${start.getMonth() + 1}月${start.getDate()}日 — 选择结束日期`
        : auditDateLabel({ range: 'custom', since: startKey, until: endKey })

  return (
    <div className="p-4">
      <ChipGroup
        aria-label="时间范围"
        className="flex-nowrap gap-1 rounded-full bg-surface-container-low p-1"
        onValueChange={selectRange}
        type="single"
        value={activeRange}
      >
        {(['7d', '30d', 'custom'] as const).map((range) => (
          <FilterChip
            className="min-w-0 flex-1 justify-center border-0 bg-transparent px-1 text-body font-normal data-[state=on]:bg-top-layer data-[state=on]:shadow-[var(--shadow-1)]"
            key={range}
            value={range}
          >
            {range === 'custom' ? '自定义' : auditDateLabel({ range, since: null, until: null })}
          </FilterChip>
        ))}
      </ChipGroup>

      {isCustom ? (
        <div className="mt-4">
          <DateRangeCalendar
            describedBy={rangeDescriptionId}
            end={end}
            focusOnMount={editingCustom}
            onSelectDay={selectDay}
            start={start}
          />
          <p
            aria-live="polite"
            className="mt-4 border-t border-chat-hairline pt-3 text-body-sm text-on-surface-variant"
            id={rangeDescriptionId}
          >
            {rangeDescription}
          </p>
        </div>
      ) : null}
    </div>
  )
}
