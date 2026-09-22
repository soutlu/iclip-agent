import { dateRangeLabel } from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DateRangePicker } from '@/shared/ui/date-range-picker'
import { FilterBarRoot, FilterPopup, useFilterBar } from '@/shared/ui/filter-bar'
import { SearchPicker, type PickerSource } from '@/shared/ui/search-picker'
import type { AuditFilters } from '../audit.api'

type AuditFiltersBarProps = {
  filters: AuditFilters
  onChange: (next: AuditFilters) => void
  users: PickerSource
  /** null 表示当前账号没有 tasks:read 权限，需求单触发器禁用。 */
  tasks: PickerSource | null
  /** 两个总数来自最新一页；还没拿到时不显示。 */
  totals: { runningTotal: number; total: number } | undefined
}

// 治理者既要看谁手上还没收尾，也要看此刻谁在跑，所以这里比侧栏多一档「进行中」。
const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '未完成' },
  { value: 'done', label: '已完成' },
  { value: 'running', label: '进行中' },
] as const

/** 「不限」而不是再写一个「全部」，两组 chip 挨着时不混。 */
const DELETED_OPTIONS = [
  { value: 'live', label: '未删除' },
  { value: 'deleted', label: '已删除' },
  { value: 'all', label: '不限' },
] as const

const CHIP_CLASS =
  'h-9 border-transparent bg-surface-container-low px-4 text-body data-[state=on]:bg-primary data-[state=on]:text-on-primary'

const TRIGGER_CLASS = 'h-11 rounded-md border border-border px-4'

/** 这一页筛的是对话建立时间，与报表页按各指标事件时刻分期的「时间」不是一回事，未选时写明这一点。 */
const createdRangeLabel = (filters: AuditFilters): string =>
  filters.range === 'all' ? '建立时间' : `建立时间：${dateRangeLabel(filters)}`

/** 一体筛选条只协调弹层与已应用条件；搜索词、临时日期保留在各选择器内。 */
export function AuditFiltersBar(props: AuditFiltersBarProps) {
  return (
    <FilterBarRoot className="gap-x-3 gap-y-4">
      <ConversationFilters {...props} />
    </FilterBarRoot>
  )
}

function ConversationFilters({ filters, onChange, users, tasks, totals }: AuditFiltersBarProps) {
  const { close } = useFilterBar()
  const userLabel =
    filters.ownerUserId === null
      ? '用户'
      : (users.options.find((user) => user.id === filters.ownerUserId)?.label ?? '已选用户')
  const taskLabel =
    filters.taskId === null
      ? '需求单'
      : (tasks?.options.find((task) => task.id === filters.taskId)?.label ?? '已选需求单')

  const apply = (patch: Partial<AuditFilters>) => {
    close()
    onChange({ ...filters, ...patch })
  }

  return (
    <>
      <div className="flex w-full min-w-0 flex-wrap items-center gap-3">
        <FilterPopup
          className={TRIGGER_CLASS}
          icon="user"
          id="user"
          label={userLabel}
          popupLabel="选择用户"
          selected={filters.ownerUserId !== null}
          triggerLabel={`用户：${userLabel}`}
          width="w-60"
        >
          <SearchPicker
            label="用户"
            onChange={(ownerUserId) => apply({ ownerUserId })}
            selectedLabel={userLabel}
            source={users}
            value={filters.ownerUserId}
            withAvatars
          />
        </FilterPopup>

        <FilterPopup
          className={TRIGGER_CLASS}
          disabled={tasks === null}
          icon="task"
          id="task"
          label={taskLabel}
          popupLabel="选择需求单"
          selected={filters.taskId !== null}
          title={tasks === null ? '当前账号没有查看需求单权限' : taskLabel}
          triggerLabel={`需求单：${taskLabel}`}
          width="w-72"
        >
          {tasks === null ? null : (
            <SearchPicker
              label="需求单"
              onChange={(taskId) => apply({ taskId })}
              selectedLabel={taskLabel}
              source={tasks}
              value={filters.taskId}
            />
          )}
        </FilterPopup>

        <FilterPopup
          align="end"
          className={TRIGGER_CLASS}
          icon="duration"
          id="time"
          label={createdRangeLabel(filters)}
          popupLabel="选择建立时间范围"
          selected={filters.range !== 'all'}
          width="w-max max-w-[calc(100vw-24px)] rounded-lg"
        >
          <DateRangePicker onChange={apply} value={filters} />
        </FilterPopup>
      </div>

      <ChipGroup
        aria-label="对话状态"
        className="gap-1"
        onValueChange={(value) => {
          const option = STATUS_OPTIONS.find((option) => option.value === value)
          if (option) apply({ state: option.value })
        }}
        type="single"
        value={filters.state}
      >
        {STATUS_OPTIONS.map((option) => (
          <FilterChip className={CHIP_CLASS} key={option.value} value={option.value}>
            {option.label}
          </FilterChip>
        ))}
      </ChipGroup>

      <ChipGroup
        aria-label="删除状态"
        className="gap-1"
        onValueChange={(value) => {
          const option = DELETED_OPTIONS.find((option) => option.value === value)
          if (option) apply({ deleted: option.value })
        }}
        type="single"
        value={filters.deleted}
      >
        {DELETED_OPTIONS.map((option) => (
          <FilterChip className={CHIP_CLASS} key={option.value} value={option.value}>
            {option.label}
          </FilterChip>
        ))}
      </ChipGroup>

      {totals === undefined ? null : (
        <p
          aria-label="对话总数"
          className="ml-auto flex shrink-0 items-center gap-1.5 px-2 py-1 text-body whitespace-nowrap text-on-surface-variant"
          role="status"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          {totals.runningTotal} 进行中
          <span aria-hidden>·</span>
          {totals.total} 段
        </p>
      )}
    </>
  )
}
