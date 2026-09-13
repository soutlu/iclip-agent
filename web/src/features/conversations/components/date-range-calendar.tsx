import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { formatLocalDate } from '../audit-dates'

type DateRangeCalendarProps = {
  /** 区间起点；只选了起点时终点为 null，网格按单个端点渲染。 */
  start: Date | null
  end: Date | null
  /** 交出被点选的一天，区间语义由调用方决定。 */
  onSelectDay: (date: Date) => void
  /** 挂载后把焦点交给可聚焦的日期，供调用方从别处切进日历时使用。 */
  focusOnMount: boolean
  /** 调用方对当前区间的说明元素 id，接到网格的 aria-describedby 上。 */
  describedBy: string
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

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

/** 按月翻页的区间日历：自持可见月份与键盘焦点，只认日期，不知道业务上的快捷范围。 */
export function DateRangeCalendar({
  start,
  end,
  onSelectDay,
  focusOnMount,
  describedBy,
}: DateRangeCalendarProps) {
  const [today] = useState(() => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    return date
  })
  const [focusedDate, setFocusedDate] = useState(() => start ?? today)
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(start ?? today))
  const focusedButtonRef = useRef<HTMLButtonElement>(null)
  const focusRequestedRef = useRef(focusOnMount)
  const monthLabelId = useId()
  const keyboardHelpId = useId()
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
  }, [focusedDate])

  const selectDay = (date: Date) => {
    setFocusedDate(date)
    onSelectDay(date)
  }

  // 翻月按钮不要求焦点归还，焦点留在按钮上，Tab 才进入该月唯一可聚焦日期。
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

  return (
    <>
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
        aria-describedby={`${describedBy} ${keyboardHelpId}`}
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
    </>
  )
}
