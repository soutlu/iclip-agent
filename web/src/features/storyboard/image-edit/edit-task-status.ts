/** 未出图任务的状态外观：缩略图条的小角标与预览区的大图标共用同一套图标、色与转圈规则。 */

import type { IconName } from '@/shared/icons'
import { phaseOfStatus } from '../shots'
import type { StripEntry } from './edit-history'

export function editTaskLook(entry: Extract<StripEntry, { kind: 'pending' | 'failed' }>): {
  icon: IconName
  /** 图标颜色的工具类。 */
  tone: string
  spin: boolean
} {
  if (entry.kind === 'failed') return { icon: 'alert', tone: 'text-error', spin: false }
  const queued = phaseOfStatus(entry.job.status) === 'queued'
  return { icon: queued ? 'duration' : 'loading', tone: 'text-primary', spin: !queued }
}
