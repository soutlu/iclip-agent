/** 三个标签页共用的筛选条：时间范围、人、需求单。人的候选 id 是上游归属用的用户名。 */

import { dateRangeLabel } from '@/shared/lib/date-range'
import { DateRangePicker } from '@/shared/ui/date-range-picker'
import { FilterBarRoot, FilterPopup, useFilterBar } from '@/shared/ui/filter-bar'
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

const TRIGGER_CLASS = 'h-10 rounded-sm px-3'

export function AuditScopeBar(props: AuditScopeBarProps) {
  return (
    <FilterBarRoot className="min-h-14 gap-x-1 gap-y-1 rounded-lg bg-surface-container-low p-2">
      <ScopeFilters {...props} />
    </FilterBarRoot>
  )
}

function ScopeFilters({ scope, onChange, users, tasks, trailing }: AuditScopeBarProps) {
  const { close } = useFilterBar()
  const userLabel =
    scope.userName === null
      ? '人'
      : (users.options.find((user) => user.id === scope.userName)?.label ?? scope.userName)
  const taskLabel =
    scope.taskId === null
      ? '需求单'
      : (tasks?.options.find((task) => task.id === scope.taskId)?.label ?? '已选需求单')

  const apply = (patch: Partial<AuditScope>) => {
    close()
    onChange({ ...scope, ...patch })
  }

  return (
    <>
      <FilterPopup
        className={TRIGGER_CLASS}
        icon="duration"
        id="time"
        label={dateRangeLabel(scope)}
        popupLabel="选择时间范围"
        selected={scope.range !== 'all'}
        triggerLabel={`时间：${dateRangeLabel(scope)}`}
        width="w-84 max-w-[calc(100vw-24px)] rounded-lg"
      >
        <DateRangePicker onChange={apply} value={scope} />
      </FilterPopup>

      <FilterPopup
        className={TRIGGER_CLASS}
        icon="user"
        id="user"
        label={userLabel}
        popupLabel="选择人"
        selected={scope.userName !== null}
        triggerLabel={`人：${userLabel}`}
        width="w-60"
      >
        <SearchPicker
          label="人"
          onChange={(userName) => apply({ userName })}
          selectedLabel={userLabel}
          source={users}
          value={scope.userName}
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
        selected={scope.taskId !== null}
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
            value={scope.taskId}
          />
        )}
      </FilterPopup>

      {trailing === undefined ? null : (
        <div className="ml-auto px-2 py-1 text-body-sm text-on-surface-variant">{trailing}</div>
      )}
    </>
  )
}
