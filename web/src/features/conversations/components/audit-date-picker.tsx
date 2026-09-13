import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { auditDateLabel, formatLocalDate, parseLocalDate } from '../audit-dates'
import type { AuditFilters } from '../audit.api'

type AuditDateValue = Pick<AuditFilters, 'range' | 'since' | 'until'>

type AuditDatePickerProps = {
  value: AuditDateValue
  /** 只交回可应用的范围；自定义只选一端时保持在组件内。 */
  onChange: (value: AuditDateValue) => void
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const
const CLEARED_RANGE: AuditDateValue = { range: 'all', since: null, until: null }

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function monthStart(date: Date): Date {
  const next = new Date(date)
  next.setDate(1)
  return next
}

/** 跨月时停在目标月最后一天，例如 1 月 31 日翻到闰年 2 月 29 日。 */
function addMonths(date: Date, months: number): Date {
  const next = monthStart(date)
  next.setMonth(next.getMonth() + months)
  const lastDay = new Date(next)
  lastDay.setMonth(lastDay.getMonth() + 1, 0)
  next.setDate(Math.min(date.getDate(), lastDay.getDate()))
  return next
}

function dateName(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/** 时间浮层内容：快捷范围即选即用，自定义范围选满两端后再应用。 */
export function AuditDatePicker({ value, onChange }: AuditDatePickerProps) {
  const [today] = useState(() => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    return date
  })
  const appliedStart =
    value.range === 'custom' && value.since !== null ? parseLocalDate(value.since) : null
  const appliedEnd =
    value.range === 'custom' && value.until !== null ? parseLocalDate(value.until) : null
  const [editingCustom, setEditingCustom] = useState(false)
  const [draftStart, setDraftStart] = useState<Date | null>(null)
  const [focusedDate, setFocusedDate] = useState(() => appliedStart ?? today)
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(appliedStart ?? today))
  const focusedButtonRef = useRef<HTMLButtonElement>(null)
  const focusRequestedRef = useRef(false)
  const monthLabelId = useId()
  const rangeDescriptionId = useId()
  const keyboardHelpId = useId()
  const isCustom = editingCustom || value.range === 'custom'
  const activeRange = isCustom ? 'custom' : value.range
  const start = draftStart ?? appliedStart
  const end = draftStart === null ? appliedEnd : null
  const startKey = start === null ? null : formatLocalDate(start)
  const endKey = end === null ? null : formatLocalDate(end)
  const focusedKey = formatLocalDate(focusedDate)
  const todayKey = formatLocalDate(today)
  const firstWeekday = (visibleMonth.getDay() + 6) % 7
  const dayCount = addDays(addMonths(visibleMonth, 1), -1).getDate()
  const weekCount = Math.ceil((firstWeekday + dayCount) / 7)

  useEffect(() => {
    if (focusRequestedRef.current) {
      focusedButtonRef.current?.focus()
      focusRequestedRef.current = false
    }
  }, [focusedDate, isCustom])

  const selectRange = (range: string) => {
    if (range === 'custom') {
      focusRequestedRef.current = true
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
    setFocusedDate(date)
    if (draftStart === null) {
      setDraftStart(date)
      return
    }
    const [since, until] = date < draftStart ? [date, draftStart] : [draftStart, date]
    onChange({ range: 'custom', since: formatLocalDate(since), until: formatLocalDate(until) })
  }

  const navigateMonth = (months: number) => {
    const next = addMonths(focusedDate, months)
    setVisibleMonth(monthStart(next))
    setFocusedDate(next)
  }

  const handleDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const weekday = (date.getDay() + 6) % 7
    let next: Date
    switch (event.key) {
      case 'ArrowLeft':
        next = addDays(date, -1)
        break
      case 'ArrowRight':
        next = addDays(date, 1)
        break
      case 'ArrowUp':
        next = addDays(date, -7)
        break
      case 'ArrowDown':
        next = addDays(date, 7)
        break
      case 'Home':
        next = addDays(date, -weekday)
        break
      case 'End':
        next = addDays(date, 6 - weekday)
        break
      case 'PageUp':
        next = addMonths(date, event.shiftKey ? -12 : -1)
        break
      case 'PageDown':
        next = addMonths(date, event.shiftKey ? 12 : 1)
        break
      default:
        return
    }
    event.preventDefault()
    focusRequestedRef.current = true
    setFocusedDate(next)
    setVisibleMonth(monthStart(next))
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
          <div className="mb-2 flex items-center justify-between">
            <IconButton label="上个月" name="back" onClick={() => navigateMonth(-1)} size="sm" />
            <p aria-live="polite" className="text-body font-medium" id={monthLabelId}>
              {visibleMonth.getFullYear()} 年 {visibleMonth.getMonth() + 1} 月
            </p>
            <IconButton label="下个月" name="next" onClick={() => navigateMonth(1)} size="sm" />
          </div>

          <p className="sr-only" id={keyboardHelpId}>
            方向键移动日期，Home 和 End 移到一周首尾，PageUp 和 PageDown 切换月份，按住 Shift
            切换年份。按 Enter 或空格选择区间起点和终点。
          </p>
          <div
            aria-describedby={`${rangeDescriptionId} ${keyboardHelpId}`}
            aria-labelledby={monthLabelId}
            aria-multiselectable
            role="grid"
          >
            <div className="grid grid-cols-7" role="row">
              {WEEKDAYS.map((day) => (
                <div
                  className="py-2 text-center text-body-sm text-on-surface-muted"
                  key={day}
                  role="columnheader"
                >
                  {day}
                </div>
              ))}
            </div>
            {Array.from({ length: weekCount }, (_, week) => {
              const weekKey = formatLocalDate(addDays(visibleMonth, week * 7 - firstWeekday))
              return (
                <div className="grid grid-cols-7" key={weekKey} role="row">
                  {WEEKDAYS.map((weekday, column) => {
                    const day = week * 7 + column - firstWeekday + 1
                    if (day < 1 || day > dayCount) return <div key={weekday} role="gridcell" />
                    const date = addDays(visibleMonth, day - 1)
                    const key = formatLocalDate(date)
                    const isStart = key === startKey
                    const isEnd = key === endKey
                    const inRange =
                      startKey !== null && endKey !== null && key >= startKey && key <= endKey
                    const endpoint = isStart || isEnd
                    return (
                      <div
                        aria-selected={endpoint || inRange}
                        className="relative grid h-10 place-items-center"
                        key={weekday}
                        role="gridcell"
                      >
                        {inRange ? (
                          <span
                            aria-hidden
                            className={cn(
                              'absolute inset-x-0 top-1/2 h-9 -translate-y-1/2 bg-state-active',
                              isStart && 'left-1/2',
                              isEnd && 'right-1/2',
                              column === 0 && 'rounded-l-full',
                              column === 6 && 'rounded-r-full',
                            )}
                          />
                        ) : null}
                        <button
                          aria-current={key === todayKey ? 'date' : undefined}
                          aria-label={dateName(date)}
                          className={cn(
                            'relative grid size-9 ui-state cursor-pointer place-items-center rounded-full text-body tabular-nums ui-focus',
                            endpoint ? 'bg-primary text-on-primary' : 'text-on-surface',
                            key === todayKey && !endpoint && 'font-semibold text-primary',
                          )}
                          onClick={() => selectDay(date)}
                          onFocus={() => setFocusedDate(date)}
                          onKeyDown={(event) => handleDayKeyDown(event, date)}
                          ref={key === focusedKey ? focusedButtonRef : undefined}
                          tabIndex={key === focusedKey ? 0 : -1}
                          type="button"
                        >
                          {day}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
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
