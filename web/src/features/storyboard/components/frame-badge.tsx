/** 帧上的图片任务角标图标；文字见 frame-status 的 frameBadgeText。 */

import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { FrameBadge } from '../frame-status'

const VIEW: Record<FrameBadge['kind'], { icon: IconName; className: string }> = {
  failed: { className: 'text-chat-status-error', icon: 'failed' },
  queued: { className: 'text-chat-status-running', icon: 'duration' },
  result: { className: 'text-chat-status-success', icon: 'success' },
  running: { className: 'text-chat-status-running', icon: 'loading' },
}

export function FrameBadgeIcon({ badge, size }: { badge: FrameBadge; size: 'xs' | 'sm' }) {
  return (
    <Icon
      className={cn(VIEW[badge.kind].className, badge.kind === 'running' && 'animate-spin')}
      decorative
      name={VIEW[badge.kind].icon}
      size={size}
    />
  )
}
