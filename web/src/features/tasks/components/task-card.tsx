import { useId } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { Task } from '../tasks.api'
import { TaskCardMedia } from './task-card-media'
import { TaskStatusTag } from './task-status-tag'

type TaskCardProps = {
  onClick: () => void
  /** 提供 onRename 时展示更多操作菜单。 */
  onRename?: (() => void) | undefined
  task: Task
}

/** 保留原列表的款号摘要，多款同时在图片区展示款数与缩略图。 */
const productsSummary = ([first, ...rest]: Task['inputs']['products']): string => {
  if (!first) return '未填商品'
  return rest.length ? `${first.style_no} 等 ${rest.length + 1} 款` : first.style_no
}

export function TaskCard({ onClick, onRename, task }: TaskCardProps) {
  const summaryId = useId()
  const statusId = useId()
  const summary = productsSummary(task.inputs.products)

  return (
    <div className="relative min-w-0">
      <button
        aria-describedby={`${summaryId} ${statusId}`}
        aria-label={`查看需求：${task.title}`}
        className="task-gallery-card flex h-full w-full min-w-0 cursor-pointer flex-col rounded-md bg-surface-container-lowest text-left ui-focus"
        onClick={onClick}
        type="button"
      >
        <TaskCardMedia products={task.inputs.products} />
        <span className="flex w-full min-w-0 flex-1 flex-col gap-1 px-3 pt-3 pb-4">
          <span
            className="block truncate text-title font-semibold text-on-surface"
            title={task.title}
          >
            {task.title}
          </span>
          <span
            className="block truncate text-body text-on-surface-variant"
            id={summaryId}
            title={summary}
          >
            {summary}
          </span>
          <span className="mt-2 flex items-center justify-between gap-3">
            <span id={statusId}>
              <TaskStatusTag appearance="dot" status={task.status} />
            </span>
            <span className="inline-flex shrink-0 items-center gap-2 text-body-sm text-on-surface">
              查看需求
              <Icon decorative name="next" size="md" />
            </span>
          </span>
        </span>
      </button>
      {onRename && (
        <MenuRoot>
          <MenuTrigger asChild>
            <IconButton
              className="absolute top-2 right-2 bg-surface-container-lowest"
              label="更多操作"
              name="more"
              size="md"
            />
          </MenuTrigger>
          <MenuSurface align="end">
            <MenuItem onSelect={onRename}>重命名</MenuItem>
          </MenuSurface>
        </MenuRoot>
      )}
    </div>
  )
}
