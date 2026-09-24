/** 三个标签页共用的筛选条：时间范围、人、需求单。人的候选 id 是上游归属用的用户名。 */

import { dateRangeLabel } from '@/shared/lib/date-range'
import { DateRangeFilter, FilterBarRoot, PickerFilter, useFilterBar } from '@/shared/ui/filter-bar'
import type { PickerSource } from '@/shared/ui/search-picker'
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

  const apply = (patch: Partial<AuditScope>) => {
    close()
    onChange({ ...scope, ...patch })
  }

  return (
    <>
      <DateRangeFilter
        className={TRIGGER_CLASS}
        label={dateRangeLabel(scope)}
        onChange={apply}
        popupLabel="选择时间范围"
        triggerLabel={`时间：${dateRangeLabel(scope)}`}
        value={scope}
      />

      {/* 上游归属的用户名不一定在名册里，不在时原样显示用户名。 */}
      <PickerFilter
        className={TRIGGER_CLASS}
        fallbackLabel={scope.userName ?? '人'}
        icon="user"
        id="user"
        noun="人"
        onChange={(userName) => apply({ userName })}
        source={users}
        value={scope.userName}
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
        value={scope.taskId}
        width="w-72"
      />

      {trailing === undefined ? null : (
        <div className="ml-auto px-2 py-1 text-body-sm text-on-surface-variant">{trailing}</div>
      )}
    </>
  )
}
