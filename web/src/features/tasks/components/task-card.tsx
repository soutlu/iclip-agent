import { useId } from 'react'
import { formatDateTime } from '@/shared/lib/date-time'
import {
  PLATFORM_ALIASES,
  PLATFORM_OPTIONS,
  VIDEO_TYPE_OPTIONS,
  CONTENT_TYPE_OPTIONS,
  videoSpecLabel,
} from '../task-video-options'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { Task } from '../tasks.api'
import { TaskCardMedia, TaskCardReferences } from './task-card-media'
import { TaskStatusTag } from './task-status-tag'

type TaskCardProps = {
  onClick: () => void
  /** 提供 onRename 时展示更多操作菜单。 */
  onRename?: (() => void) | undefined
  task: Task
}

/** 多款保留首款与总数，完整商品信息仍在需求详情展示。 */
const productsSummary = ([first, ...rest]: Task['inputs']['products']): string => {
  if (!first) return '未填商品'
  return rest.length ? `${first.style_no} 等 ${rest.length + 1} 款` : first.style_no
}

export function TaskCard({ onClick, onRename, task }: TaskCardProps) {
  const summaryId = useId()
  const statusId = useId()
  const summary = productsSummary(task.inputs.products)

  const spec = task.inputs.video_spec
  const platform = videoSpecLabel(spec.platform, PLATFORM_OPTIONS) || '未填平台'
  const videoType = videoSpecLabel(spec.video_type, VIDEO_TYPE_OPTIONS) || '未填视频类型'
  const contentType = videoSpecLabel(spec.content_type, CONTENT_TYPE_OPTIONS) || '未填内容类型'
  const createdAt = formatDateTime(task.createdAt)
  // 仅省略已由平台、款号字段表达的前缀；原始标题用于详情及可访问名称。
  const platformKey = spec.platform.toLowerCase()
  const prefixes = new Set([
    platformKey,
    ...(PLATFORM_ALIASES[platformKey] ?? []),
    ...task.inputs.products.map((p) => p.style_no.toLowerCase()),
  ])
  const displayTitle =
    task.title
      .replace(/^(?:\[[^\]]+\])+\s*/, (prefix) =>
        [...prefix.matchAll(/\[([^\]]+)\]/g)].every((match) =>
          prefixes.has((match[1] ?? '').toLowerCase()),
        )
          ? ''
          : prefix,
      )
      .trim() || task.title

  return (
    <div className="relative min-w-0">
      <button
        aria-describedby={`${summaryId} ${statusId}`}
        aria-label={`查看需求：${task.title}`}
        className="task-gallery-card flex h-full w-full min-w-0 cursor-pointer flex-col rounded-md text-left ui-focus"
        onClick={onClick}
        type="button"
      >
        <TaskCardMedia products={task.inputs.products} />
        <span className="flex w-full min-w-0 flex-col gap-1 pt-2">
          <span className="line-clamp-2 text-body font-semibold text-on-surface" title={task.title}>
            {displayTitle}
          </span>
          <span
            className="block truncate text-body-sm text-on-surface-variant"
            id={summaryId}
            title={`${platform} · ${summary}`}
          >
            <span aria-label={`发布平台：${platform}`}>{platform}</span> · {summary}
          </span>
          <span
            className="block truncate text-body-sm text-on-surface-variant"
            title={`${videoType} · ${contentType}`}
          >
            <span aria-label={`视频类型：${videoType}`}>{videoType}</span> ·{' '}
            <span aria-label={`内容类型：${contentType}`}>{contentType}</span>
          </span>
          <time
            className="text-caption text-on-surface-variant"
            dateTime={task.createdAt}
            title={createdAt}
          >
            创建于 {createdAt.slice(5).replaceAll('-', '/')}
          </time>
        </span>
      </button>
      <span
        className="pointer-events-none absolute top-2 left-2 rounded-full bg-surface-container-lowest/95 px-2 py-1"
        id={statusId}
      >
        <TaskStatusTag appearance="dot" status={task.status} />
      </span>
      <TaskCardReferences inputs={task.inputs} onOpen={onClick} />
      {onRename && (
        <MenuRoot>
          <MenuTrigger asChild>
            <IconButton
              className="absolute top-2 right-2 bg-surface-container-lowest"
              label="更多操作"
              name="more"
              size="xs"
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
