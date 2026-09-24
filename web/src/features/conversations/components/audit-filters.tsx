import { dateRangeLabel } from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DateRangeFilter, FilterBarRoot, PickerFilter, useFilterBar } from '@/shared/ui/filter-bar'
import type { PickerSource } from '@/shared/ui/search-picker'
import { auditDeletedSchema, type AuditFilters } from '../audit.api'
import { conversationListStateSchema } from '../conversations.api'

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
// 两张文案表的键由合同枚举约束，chip 按声明顺序排。
const STATUS_LABELS = {
  all: '全部',
  open: '未完成',
  done: '已完成',
  running: '进行中',
} satisfies Record<AuditFilters['state'], string>

/** 「不限」而不是再写一个「全部」，两组 chip 挨着时不混。 */
const DELETED_LABELS = {
  live: '未删除',
  deleted: '已删除',
  all: '不限',
} satisfies Record<AuditFilters['deleted'], string>

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

  const apply = (patch: Partial<AuditFilters>) => {
    close()
    onChange({ ...filters, ...patch })
  }

  return (
    <>
      <div className="flex w-full min-w-0 flex-wrap items-center gap-3">
        <PickerFilter
          className={TRIGGER_CLASS}
          fallbackLabel="已选用户"
          icon="user"
          id="user"
          noun="用户"
          onChange={(ownerUserId) => apply({ ownerUserId })}
          source={users}
          value={filters.ownerUserId}
          width="w-60"
          withAvatars
        />

        <PickerFilter
          className={TRIGGER_CLASS}
          disabledTitle="当前账号没有查看需求单权限"
          fallbackLabel="已选需求单"
          icon="task"
          id="task"
          noun="需求单"
          onChange={(taskId) => apply({ taskId })}
          source={tasks}
          value={filters.taskId}
          width="w-72"
        />

        <DateRangeFilter
          align="end"
          className={TRIGGER_CLASS}
          label={createdRangeLabel(filters)}
          onChange={apply}
          popupLabel="选择建立时间范围"
          value={filters}
        />
      </div>

      <ChipGroup
        aria-label="对话状态"
        className="gap-1"
        onValueChange={(value) => {
          const state = conversationListStateSchema.safeParse(value)
          if (state.success) apply({ state: state.data })
        }}
        type="single"
        value={filters.state}
      >
        {Object.entries(STATUS_LABELS).map(([value, label]) => (
          <FilterChip className={CHIP_CLASS} key={value} value={value}>
            {label}
          </FilterChip>
        ))}
      </ChipGroup>

      <ChipGroup
        aria-label="删除状态"
        className="gap-1"
        onValueChange={(value) => {
          const deleted = auditDeletedSchema.safeParse(value)
          if (deleted.success) apply({ deleted: deleted.data })
        }}
        type="single"
        value={filters.deleted}
      >
        {Object.entries(DELETED_LABELS).map(([value, label]) => (
          <FilterChip className={CHIP_CLASS} key={value} value={value}>
            {label}
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
