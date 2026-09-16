/** 三个标签页共用的筛选条：时间范围、人、需求单。人的候选 id 是上游归属用的用户名。 */

import { useRef, useState, type ComponentPropsWithRef } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { dateRangeLabel } from '@/shared/lib/date-range'
import { cn } from '@/shared/lib/utils'
import { DateRangePicker } from '@/shared/ui/date-range-picker'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { SearchPicker, type PickerSource } from '@/shared/ui/search-picker'
import type { AuditScope } from '../audit.api'

type AuditScopeBarProps = {
  scope: AuditScope
  onChange: (next: AuditScope) => void
  users: PickerSource
  /** null 表示当前账号没有 tasks:read 权限，需求单触发器禁用。 */
  tasks: PickerSource | null
  /** 右侧的补充说明，如「数据截至…」。 */
  trailing?: React.ReactNode
}

type OpenFilter = 'time' | 'user' | 'task' | null

export function AuditScopeBar({ scope, onChange, users, tasks, trailing }: AuditScopeBarProps) {
  const [openFilter, setOpenFilter] = useState<OpenFilter>(null)
  const timeTriggerRef = useRef<HTMLButtonElement>(null)
  const userTriggerRef = useRef<HTMLButtonElement>(null)
  const taskTriggerRef = useRef<HTMLButtonElement>(null)
  const userLabel =
    scope.userName === null
      ? '人'
      : (users.options.find((user) => user.id === scope.userName)?.label ?? scope.userName)
  const taskLabel =
    scope.taskId === null
      ? '需求单'
      : (tasks?.options.find((task) => task.id === scope.taskId)?.label ?? '已选需求单')

  const apply = (patch: Partial<AuditScope>) => {
    const triggerRefs = { time: timeTriggerRef, user: userTriggerRef, task: taskTriggerRef }
    // 在移除选择器前归还焦点，避免活动元素随草稿一起卸载后落到页面 body。
    if (openFilter !== null) triggerRefs[openFilter].current?.focus()
    onChange({ ...scope, ...patch })
    setOpenFilter(null)
  }

  const changeOpen = (filter: Exclude<OpenFilter, null>, open: boolean) => {
    setOpenFilter((current) => (open ? filter : current === filter ? null : current))
  }

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-1 gap-y-1 rounded-lg bg-surface-container-low p-2">
      <PopupRoot onOpenChange={(open) => changeOpen('time', open)} open={openFilter === 'time'}>
        <PopupTrigger asChild>
          <ScopeTrigger
            aria-label={`时间：${dateRangeLabel(scope)}`}
            icon="duration"
            label={dateRangeLabel(scope)}
            ref={timeTriggerRef}
            selected={scope.range !== 'all'}
          />
        </PopupTrigger>
        <PopupSurface
          align="start"
          aria-label="选择时间范围"
          className="w-84 max-w-[calc(100vw-24px)] rounded-lg"
          collisionPadding={12}
          showArrow
          sideOffset={6}
        >
          {openFilter === 'time' ? <DateRangePicker onChange={apply} value={scope} /> : null}
        </PopupSurface>
      </PopupRoot>

      <PopupRoot onOpenChange={(open) => changeOpen('user', open)} open={openFilter === 'user'}>
        <PopupTrigger asChild>
          <ScopeTrigger
            aria-label={`人：${userLabel}`}
            icon="user"
            label={userLabel}
            ref={userTriggerRef}
            selected={scope.userName !== null}
          />
        </PopupTrigger>
        <PopupSurface
          align="start"
          aria-label="选择人"
          className="w-60"
          collisionPadding={12}
          showArrow
          sideOffset={6}
        >
          {openFilter === 'user' ? (
            <SearchPicker
              label="人"
              onChange={(userName) => apply({ userName })}
              selectedLabel={userLabel}
              source={users}
              value={scope.userName}
              withAvatars
            />
          ) : null}
        </PopupSurface>
      </PopupRoot>

      <PopupRoot onOpenChange={(open) => changeOpen('task', open)} open={openFilter === 'task'}>
        <PopupTrigger asChild>
          <ScopeTrigger
            aria-label={`需求单：${taskLabel}`}
            disabled={tasks === null}
            icon="task"
            label={taskLabel}
            ref={taskTriggerRef}
            selected={scope.taskId !== null}
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
            <SearchPicker
              label="需求单"
              onChange={(taskId) => apply({ taskId })}
              selectedLabel={taskLabel}
              source={tasks}
              value={scope.taskId}
            />
          ) : null}
        </PopupSurface>
      </PopupRoot>

      {trailing === undefined ? null : (
        <div className="ml-auto px-2 py-1 text-body-sm text-on-surface-variant">{trailing}</div>
      )}
    </div>
  )
}

type ScopeTriggerProps = ComponentPropsWithRef<'button'> & {
  icon: IconName
  label: string
  selected: boolean
}

function ScopeTrigger({ icon, label, selected, className, ...props }: ScopeTriggerProps) {
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
