import { useEffect, useRef, useState } from 'react'
import {
  DayPicker,
  type ChevronProps,
  type ClassNames,
  type DayButtonProps,
  type DayProps,
  type Formatters,
  type Labels,
  type ModifiersClassNames,
} from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import { Icon } from '@/shared/icons'
import {
  dateRangeLabel,
  dateRangePresetDays,
  formatLocalDate,
  parseLocalDate,
  UNBOUNDED_RANGE,
  type DateRange,
} from '@/shared/lib/date-range'
import { cn } from '@/shared/lib/utils'
import { iconButtonVariants } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'

type DateRangePickerProps = {
  value: DateRange
  /** 只交回可应用的范围；自定义只选一端时保持在组件内。 */
  onChange: (value: DateRange) => void
}

const CLEARED_RANGE = UNBOUNDED_RANGE

/** 表头星期名，按 getDay() 取，不依赖 locale 的星期宽度。 */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

/** 与 Tailwind 的 sm 断点一致：宽屏并排两个月。 */
const WIDE_SCREEN = '(min-width: 40rem)'

const dateName = (date: Date): string =>
  `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`

const monthName = (month: Date): string => `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`

const startOfDay = (date: Date): Date => {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const DAY_CELL = 'h-10 p-0 text-center'

const CALENDAR_CLASS_NAMES: Partial<ClassNames> = {
  button_next: iconButtonVariants({ size: 'sm' }),
  button_previous: iconButtonVariants({ size: 'sm' }),
  caption_label: 'text-body font-medium',
  day: DAY_CELL,
  footer: 'mt-4 border-t border-chat-hairline pt-3 text-body-sm text-on-surface-variant',
  // 固定 280px：七列正好 40px 见方，两个月并排也放得进 sm 宽度的弹层。
  month: 'w-70',
  month_caption: 'mb-2 flex h-(--control-height-sm) items-center justify-center',
  month_grid: 'w-full table-fixed border-collapse',
  // 翻月按钮压在第一行的两端，两个月并排时也只有一组。
  months: 'relative flex gap-5',
  nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
  weekday: 'py-2 text-center text-body-sm font-normal text-on-surface-muted',
}

/** 区间底色落在格子上，端点的实心圆在按钮上；预设高亮只是展示，配色比自定义区间更淡。 */
const MODIFIER_CLASS_NAMES: ModifiersClassNames = {
  inRange: 'bg-state-active',
  preset: 'bg-state-hover',
  rangeEnd: 'rounded-r-full',
  rangeStart: 'rounded-l-full',
}

const CALENDAR_FORMATTERS: Partial<Formatters> = {
  formatCaption: monthName,
  formatWeekdayName: (weekday) => WEEKDAY_NAMES[weekday.getDay()] ?? '',
}

const CALENDAR_LABELS: Partial<Labels> = {
  labelDayButton: dateName,
  labelGrid: monthName,
  labelNext: () => '下个月',
  labelPrevious: () => '上个月',
}

/** 月首月末补位的空格子不跟着区间与预设铺底，只留格子本身的尺寸。 */
function CalendarDay({ day: _day, modifiers, className, ...props }: DayProps) {
  const filler = modifiers['hidden'] === true || modifiers['outside'] === true
  return <td {...props} className={filler ? DAY_CELL : className} />
}

/** 日期按钮：端点实心、今天描色；焦点交接沿用 DayPicker 默认按钮的做法。 */
function CalendarDayButton({
  day: _day,
  modifiers,
  className: _className,
  ...props
}: DayButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const endpoint = modifiers['endpoint'] === true
  const focused = modifiers['focused'] === true

  useEffect(() => {
    if (focused) ref.current?.focus()
  }, [focused])

  return (
    <button
      {...props}
      aria-current={modifiers['today'] === true ? 'date' : undefined}
      className={cn(
        'relative mx-auto grid size-9 ui-state cursor-pointer place-items-center rounded-full text-body tabular-nums ui-focus',
        endpoint ? 'bg-primary text-on-primary' : 'text-on-surface',
        modifiers['today'] === true && !endpoint && 'font-semibold text-primary',
      )}
      data-preset={modifiers['preset'] === true ? true : undefined}
      ref={ref}
    />
  )
}

const CALENDAR_COMPONENTS = {
  Chevron: ({ orientation }: ChevronProps) => (
    <Icon decorative name={orientation === 'left' ? 'back' : 'next'} size="md" />
  ),
  Day: CalendarDay,
  DayButton: CalendarDayButton,
}

/** 宽屏并排两个月；shared 里还没有通用的媒体查询 hook，这里只读这一条。 */
function useWideScreen(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_SCREEN).matches)

  useEffect(() => {
    const query = window.matchMedia(WIDE_SCREEN)
    const sync = () => setWide(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  return wide
}

/** 时间浮层内容：快捷范围即选即用并在日历上高亮，点日期开始自定义草稿，选满两端后再应用。 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [today] = useState(() => startOfDay(new Date()))
  const [editingCustom, setEditingCustom] = useState(false)
  const [draftStart, setDraftStart] = useState<Date | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const wideScreen = useWideScreen()
  const appliedStart =
    value.range === 'custom' && value.since !== null ? parseLocalDate(value.since) : null
  const appliedEnd =
    value.range === 'custom' && value.until !== null ? parseLocalDate(value.until) : null
  const isCustom = editingCustom || draftStart !== null || value.range === 'custom'
  const activeRange = isCustom ? 'custom' : value.range
  const start = draftStart ?? appliedStart
  const end = draftStart === null ? appliedEnd : null
  const fullRange = start !== null && end !== null ? { from: start, to: end } : undefined
  const presetDays = dateRangePresetDays(value.range)

  // 日历常驻，可聚焦的那一天始终在 DOM 里，从 chip 切进自定义时直接把焦点交给它。
  const focusCalendar = () => {
    rootRef.current?.querySelector<HTMLButtonElement>('td button[tabindex="0"]')?.focus()
  }

  const selectRange = (range: string) => {
    if (range === 'custom') {
      setEditingCustom(true)
      focusCalendar()
      return
    }
    setDraftStart(null)
    setEditingCustom(false)
    if (range === '7d' || range === '30d') {
      onChange(value.range === range ? CLEARED_RANGE : { range, since: null, until: null })
      return
    }
    // 空值来自再次点击当前 chip：草稿只丢草稿，已生效的范围才清除筛选。
    if (range === '' && !(isCustom && value.range !== 'custom')) {
      onChange(CLEARED_RANGE)
    }
  }

  const selectDay = (date: Date) => {
    if (draftStart === null) {
      setDraftStart(date)
      return
    }
    const [since, until] = date < draftStart ? [date, draftStart] : [draftStart, date]
    setDraftStart(null)
    onChange({ range: 'custom', since: formatLocalDate(since), until: formatLocalDate(until) })
  }

  const rangeDescription =
    start === null
      ? '选择开始日期'
      : end === null
        ? `${start.getMonth() + 1}月${start.getDate()}日 — 选择结束日期`
        : dateRangeLabel({
            range: 'custom',
            since: formatLocalDate(start),
            until: formatLocalDate(end),
          })

  return (
    <div className="p-4" ref={rootRef}>
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
            {range === 'custom' ? '自定义' : dateRangeLabel({ range, since: null, until: null })}
          </FilterChip>
        ))}
      </ChipGroup>

      <div className="mt-4">
        <DayPicker
          classNames={CALENDAR_CLASS_NAMES}
          components={CALENDAR_COMPONENTS}
          defaultMonth={start ?? today}
          footer={rangeDescription}
          formatters={CALENDAR_FORMATTERS}
          labels={CALENDAR_LABELS}
          locale={zhCN}
          modifiers={{
            endpoint: [start, end].filter((date): date is Date => date !== null),
            inRange: fullRange,
            preset:
              presetDays === null ? undefined : { from: addDays(today, 1 - presetDays), to: today },
            rangeEnd: fullRange?.to,
            rangeStart: fullRange?.from,
            // 只有「选中」进 aria-selected，预设高亮不占这个语义。
            selected: fullRange ?? start ?? undefined,
          }}
          modifiersClassNames={MODIFIER_CLASS_NAMES}
          numberOfMonths={wideScreen ? 2 : 1}
          onDayClick={selectDay}
          today={today}
          weekStartsOn={1}
        />
      </div>
    </div>
  )
}
