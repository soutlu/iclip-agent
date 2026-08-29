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

/** 需求单状态的中文标签与配色，卡片与弹窗共用同一份映射。 */
export function TaskStatusTag({ status }: { status: Task['status'] }) {
  return <Tag variant={STATUS_VARIANT[status] ?? 'soft'}>{STATUS_LABEL[status] ?? status}</Tag>
}
