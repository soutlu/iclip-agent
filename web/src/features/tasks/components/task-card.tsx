import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { formatRelativeTime } from '../relative-time'
import type { Task } from '../tasks.api'
import { TaskStatusTag } from './task-status-tag'

type TaskCardProps = {
  onClick: () => void
  /** 给了就在卡片右侧渲染悬停浮现的「更多操作」菜单（重命名入口），不给就是纯卡片 */
  onRename?: (() => void) | undefined
  task: Task
}

/** 项目卡片：图标底块 + 标题 + 状态与时间，点击开详情弹窗。 */
export function TaskCard({ onClick, onRename, task }: TaskCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="group relative">
      <button
        className={cn(
          'flex min-h-20 w-full ui-state cursor-pointer items-center gap-3 rounded-md border border-border bg-surface-container-lowest px-4 py-3.5 text-left ui-focus',
          onRename && 'pr-10',
        )}
        onClick={onClick}
        type="button"
      >
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-container text-on-surface-variant"
        >
          <Icon decorative name="task" size="lg" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate text-title font-semibold text-on-surface">
              {task.title}
            </span>
            <span className="shrink-0">
              <TaskStatusTag status={task.status} />
            </span>
          </span>
          <span className="mt-1 block truncate text-body-sm text-on-surface-variant">
            {task.style.styleNo} · 添加于 {formatRelativeTime(task.createdAt)}
          </span>
        </span>
      </button>
      {onRename && (
        <MenuRoot onOpenChange={setMenuOpen} open={menuOpen}>
          <MenuTrigger asChild>
            <button
              aria-label="更多操作"
              className={cn(
                'absolute top-1/2 right-3.5 grid size-6 -translate-y-1/2 ui-state cursor-pointer place-items-center rounded-sm text-on-surface-variant ui-focus',
                menuOpen
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              )}
              type="button"
            >
              <Icon decorative name="more" size="md" />
            </button>
          </MenuTrigger>
          <MenuSurface align="end">
            <MenuItem onSelect={onRename}>重命名</MenuItem>
          </MenuSurface>
        </MenuRoot>
      )}
    </div>
  )
}
