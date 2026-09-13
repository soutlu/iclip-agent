import { useRef, useState, type ComponentPropsWithRef } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { auditDateLabel } from '../audit-dates'
import type { AuditFilters } from '../audit.api'
import { AuditDatePicker } from './audit-date-picker'
import { AuditSearchPicker, type PickerSource } from './audit-search-picker'

type AuditFiltersBarProps = {
  filters: AuditFilters
  onChange: (next: AuditFilters) => void
  users: PickerSource
  /** null 表示当前账号没有 tasks:read 权限，需求单触发器禁用。 */
  tasks: PickerSource | null
  /** 两个总数来自最新一页；还没拿到时不显示。 */
  totals: { runningTotal: number; total: number } | undefined
}

type OpenFilter = 'user' | 'task' | 'time' | null

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '进行中' },
  { value: 'done', label: '已完成' },
] as const

/** 一体筛选条只协调弹层与已应用条件；搜索词、临时日期保留在各选择器内。 */
export function AuditFiltersBar({ filters, onChange, users, tasks, totals }: AuditFiltersBarProps) {
  const [openFilter, setOpenFilter] = useState<OpenFilter>(null)
  const userTriggerRef = useRef<HTMLButtonElement>(null)
  const taskTriggerRef = useRef<HTMLButtonElement>(null)
  const timeTriggerRef = useRef<HTMLButtonElement>(null)
  const userLabel =
    filters.ownerUserId === null
      ? '用户'
      : (users.options.find((user) => user.id === filters.ownerUserId)?.label ?? '已选用户')
  const taskLabel =
    filters.taskId === null
      ? '需求单'
      : (tasks?.options.find((task) => task.id === filters.taskId)?.label ?? '已选需求单')

  const apply = (patch: Partial<AuditFilters>) => {
    const triggerRefs = { user: userTriggerRef, task: taskTriggerRef, time: timeTriggerRef }
    // 在移除选择器前归还焦点，避免活动元素随草稿一起卸载后落到页面 body。
    if (openFilter !== null) triggerRefs[openFilter].current?.focus()
    onChange({ ...filters, ...patch })
    setOpenFilter(null)
  }

  const changeOpen = (filter: Exclude<OpenFilter, null>, open: boolean) => {
    // 切换触发器时，旧弹层的关闭事件不能清掉刚打开的新弹层。
    setOpenFilter((current) => (open ? filter : current === filter ? null : current))
  }

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface-container-low p-2">
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
          <FilterChip
            className="h-9 border-transparent bg-transparent px-4 text-body data-[state=on]:bg-surface-container-lowest data-[state=on]:shadow-[var(--shadow-1)]"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </FilterChip>
        ))}
      </ChipGroup>

      <span aria-hidden className="mx-1 h-5 w-px bg-border max-sm:hidden" />

      <div className="flex min-w-0 flex-wrap items-center gap-1 max-sm:w-full">
        <PopupRoot onOpenChange={(open) => changeOpen('user', open)} open={openFilter === 'user'}>
          <PopupTrigger asChild>
            <FilterTrigger
              aria-label={`用户：${userLabel}`}
              icon="user"
              label={userLabel}
              ref={userTriggerRef}
              selected={filters.ownerUserId !== null}
            />
          </PopupTrigger>
          <PopupSurface
            align="start"
            aria-label="选择用户"
            className="w-60"
            collisionPadding={12}
            showArrow
            sideOffset={6}
          >
            {openFilter === 'user' ? (
              <AuditSearchPicker
                label="用户"
                onChange={(ownerUserId) => apply({ ownerUserId })}
                selectedLabel={userLabel}
                source={users}
                value={filters.ownerUserId}
                withAvatars
              />
            ) : null}
          </PopupSurface>
        </PopupRoot>

        <PopupRoot onOpenChange={(open) => changeOpen('task', open)} open={openFilter === 'task'}>
          <PopupTrigger asChild>
            <FilterTrigger
              aria-label={`需求单：${taskLabel}`}
              disabled={tasks === null}
              icon="task"
              label={taskLabel}
              ref={taskTriggerRef}
              selected={filters.taskId !== null}
              title={tasks === null ? '当前账号没有查看需求单权限' : taskLabel}
            />
          </PopupTrigger>
          <PopupSurface
            align="start"
            aria-label="选择需求单"
            className="w-72"
            collisionPadding={12}
            showArrow
            sideOffset={6}
          >
            {openFilter === 'task' && tasks !== null ? (
              <AuditSearchPicker
                label="需求单"
                onChange={(taskId) => apply({ taskId })}
                selectedLabel={taskLabel}
                source={tasks}
                value={filters.taskId}
              />
            ) : null}
          </PopupSurface>
        </PopupRoot>

        <PopupRoot onOpenChange={(open) => changeOpen('time', open)} open={openFilter === 'time'}>
          <PopupTrigger asChild>
            <FilterTrigger
              aria-label={`时间：${auditDateLabel(filters)}`}
              icon="duration"
              label={auditDateLabel(filters)}
              ref={timeTriggerRef}
              selected={filters.range !== 'all'}
            />
          </PopupTrigger>
          <PopupSurface
            align="end"
            aria-label="选择时间范围"
            className="w-84 max-w-[calc(100vw-24px)] rounded-lg"
            collisionPadding={12}
            showArrow
            sideOffset={6}
          >
            {openFilter === 'time' ? <AuditDatePicker onChange={apply} value={filters} /> : null}
          </PopupSurface>
        </PopupRoot>
      </div>

      {totals === undefined ? null : (
        <p
          aria-label="对话总数"
          className="ml-auto flex shrink-0 items-center gap-1.5 px-2 py-1 text-body-sm whitespace-nowrap text-on-surface-variant"
          role="status"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          {totals.runningTotal} 进行中
          <span aria-hidden>·</span>
          {totals.total} 段
        </p>
      )}
    </div>
  )
}

type FilterTriggerProps = ComponentPropsWithRef<'button'> & {
  icon: IconName
  label: string
  selected: boolean
}

function FilterTrigger({ icon, label, selected, className, ...props }: FilterTriggerProps) {
  return (
    <button
      className={cn(
        'inline-flex h-10 min-w-0 ui-state cursor-pointer items-center gap-2 rounded-sm px-3 text-body text-on-surface ui-focus data-[state=open]:bg-state-active',
        // 主色文字只表示「已应用非默认条件」，展开态与选中底都走中性状态层。
        selected && 'text-primary',
        className,
      )}
      title={label}
      type="button"
      {...props}
    >
      <Icon decorative name={icon} size="sm" />
      <span className="max-w-44 truncate">{label}</span>
      <Icon className="text-on-surface-variant" decorative name="expand" size="xs" />
    </button>
  )
}
