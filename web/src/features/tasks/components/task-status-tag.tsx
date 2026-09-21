import { cva } from 'class-variance-authority'
import { Tag } from '@/shared/ui/tag'
import type { Task } from '../tasks.api'

const STATUS_LABEL: Record<string, string> = {
  confirmed: '进行中',
  draft: '草稿',
  published: '待认领',
  withdrawn: '已撤回',
}

const STATUS_VARIANT: Record<string, 'soft' | 'running' | 'success' | 'error'> = {
  confirmed: 'success',
  draft: 'soft',
  published: 'running',
  withdrawn: 'error',
}

const statusDotVariants = cva('inline-flex items-center gap-2 text-body-sm font-medium', {
  variants: {
    variant: {
      soft: 'text-on-surface-variant',
      running: 'text-warning',
      success: 'text-primary',
      error: 'text-error',
    },
  },
})

/** 需求单状态的中文标签与配色，卡片与弹窗共用同一份映射。 */
export function TaskStatusTag({
  appearance = 'tag',
  status,
}: {
  appearance?: 'tag' | 'dot'
  status: Task['status']
}) {
  const label = STATUS_LABEL[status] ?? status
  const variant = STATUS_VARIANT[status] ?? 'soft'

  if (appearance === 'dot') {
    return (
      <span className={statusDotVariants({ variant })}>
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-current" />
        {label}
      </span>
    )
  }

  return <Tag variant={variant}>{label}</Tag>
}
