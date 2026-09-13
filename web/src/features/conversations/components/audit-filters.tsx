import type { DirectoryUser } from '@/shared/auth'
import { AssistChip, ChipGroup, FilterChip } from '@/shared/ui/chip'
import { Input } from '@/shared/ui/field'
import {
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import type { AuditFilters, AuditRange } from '../audit.api'
import type { ConversationListState } from '../conversations.api'

export type TaskOption = { id: string; label: string }

type AuditFiltersBarProps = {
  filters: AuditFilters
  onChange: (next: AuditFilters) => void
  owners: readonly DirectoryUser[]
  tasks: readonly TaskOption[]
  /** 两个真总数来自最新一页；还没拿到时不显示。 */
  totals: { runningTotal: number; total: number } | undefined
}

const RANGE_LABELS: Record<AuditRange, string> = {
  '30d': '近 30 天',
  '7d': '近 7 天',
  all: '全部时间',
  custom: '自定义',
}

// 单选菜单用空串表示「不筛」，Radix 的 RadioGroup 不接受 null。
const ANY = ''

/** 三态片加三个下拉：属主、需求单、时间；自定义时间再多两个日期框。 */
export function AuditFiltersBar({
  filters,
  onChange,
  owners,
  tasks,
  totals,
}: AuditFiltersBarProps) {
  const ownerLabel =
    filters.ownerUserId === null
      ? '全部属主'
      : (owners.find((owner) => owner.id === filters.ownerUserId)?.displayName ?? '指定属主')
  const taskLabel =
    filters.taskId === null
      ? '全部需求单'
      : (tasks.find((task) => task.id === filters.taskId)?.label ?? '指定需求单')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ChipGroup
          aria-label="对话状态"
          // 忽略 Radix 取消当前选项产生的空串，保持筛选始终有值。
          onValueChange={(value) =>
            value && onChange({ ...filters, state: value as ConversationListState })
          }
          type="single"
          value={filters.state}
        >
          <FilterChip value="all">全部</FilterChip>
          <FilterChip value="running">进行中</FilterChip>
          <FilterChip value="done">已完成</FilterChip>
        </ChipGroup>

        <span aria-hidden className="h-5 w-px bg-outline-variant" />

        <MenuRoot>
          <MenuTrigger asChild>
            <AssistChip aria-label={`属主：${ownerLabel}`} leadingIcon="user">
              {ownerLabel}
            </AssistChip>
          </MenuTrigger>
          <MenuSurface align="start" className="max-h-80 min-w-48 overflow-y-auto">
            <MenuRadioGroup
              onValueChange={(value) => onChange({ ...filters, ownerUserId: value || null })}
              value={filters.ownerUserId ?? ANY}
            >
              <MenuRadioItem value={ANY}>全部属主</MenuRadioItem>
              <MenuSeparator />
              {owners.map((owner) => (
                <MenuRadioItem key={owner.id} value={owner.id}>
                  {owner.displayName}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>

        <MenuRoot>
          <MenuTrigger asChild>
            <AssistChip aria-label={`需求单：${taskLabel}`} leadingIcon="task">
              {taskLabel}
            </AssistChip>
          </MenuTrigger>
          <MenuSurface align="start" className="max-h-80 min-w-48 overflow-y-auto">
            <MenuRadioGroup
              onValueChange={(value) => onChange({ ...filters, taskId: value || null })}
              value={filters.taskId ?? ANY}
            >
              <MenuRadioItem value={ANY}>全部需求单</MenuRadioItem>
              <MenuSeparator />
              {tasks.map((task) => (
                <MenuRadioItem key={task.id} value={task.id}>
                  {task.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>

        <MenuRoot>
          <MenuTrigger asChild>
            <AssistChip aria-label={`时间：${RANGE_LABELS[filters.range]}`} leadingIcon="duration">
              {RANGE_LABELS[filters.range]}
            </AssistChip>
          </MenuTrigger>
          <MenuSurface align="start" className="min-w-40">
            <MenuRadioGroup
              onValueChange={(value) => onChange({ ...filters, range: value as AuditRange })}
              value={filters.range}
            >
              {(['all', '7d', '30d', 'custom'] as const).map((range) => (
                <MenuRadioItem key={range} value={range}>
                  {RANGE_LABELS[range]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSurface>
        </MenuRoot>

        {totals === undefined ? null : (
          <p
            aria-label="对话总数"
            className="ml-auto text-body-sm text-on-surface-variant"
            role="status"
          >
            <strong className="font-medium text-on-surface">{totals.runningTotal}</strong> 段在跑 ·
            共 <strong className="font-medium text-on-surface">{totals.total}</strong> 段
          </p>
        )}
      </div>

      {filters.range === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2 text-body-sm text-on-surface-variant">
          <Input
            aria-label="开始日期"
            className="w-44"
            onChange={(event) => onChange({ ...filters, since: event.target.value || null })}
            type="date"
            value={filters.since ?? ''}
          />
          <span>到</span>
          <Input
            aria-label="结束日期"
            className="w-44"
            onChange={(event) => onChange({ ...filters, until: event.target.value || null })}
            type="date"
            value={filters.until ?? ''}
          />
        </div>
      ) : null}
    </div>
  )
}
