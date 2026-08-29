import { Icon } from '@/shared/icons'
import { formatRelativeTime } from '../relative-time'
import type { Task } from '../tasks.api'
import { TaskStatusTag } from './task-status-tag'

type TaskCardProps = {
  onClick: () => void
  task: Task
}

/** 项目卡片：图标底块 + 标题 + 状态与时间，点击开详情弹窗。 */
export function TaskCard({ onClick, task }: TaskCardProps) {
  return (
    <button
      className="flex w-full ui-state cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface-container-lowest p-4 text-left ui-focus"
      onClick={onClick}
      type="button"
    >
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-container text-on-surface-variant"
      >
        <Icon decorative name="task" size="md" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-on-surface">{task.title}</span>
          <TaskStatusTag status={task.status} />
        </span>
        <span className="mt-1 block truncate text-body-sm text-on-surface-variant">
          {task.style.styleNo} · 更新于 {formatRelativeTime(task.updatedAt)}
        </span>
      </span>
    </button>
  )
}
