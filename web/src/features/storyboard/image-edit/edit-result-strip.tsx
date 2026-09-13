/** 这一帧出现过的图，挂在画布下沿。只画调用方给的条目，不查数据。 */

import { Icon } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { cn } from '@/shared/lib/utils'
import { StatusBadge } from '@/shared/ui/status-badge'
import { phaseOfStatus } from '../shots'
import type { StripEntry } from './edit-history'

type EditResultStripProps = {
  entries: readonly StripEntry[]
  selectedKey: string
  onSelect: (key: string) => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}

/** 只有还没落地的任务才占独立一格；完成的任务已经变成它产出的那张图。 */
const PHASE_LABEL: Record<'failed' | 'queued' | 'running', string> = {
  failed: '失败',
  queued: '排队中',
  running: '生成中',
}

/** 条目的可访问名；时间让同一格里的多张图彼此分得开。
 *
 * 没有产出它的任务，说明这张图是被别的任务当底图才留下来的——它当过这一帧，叫「上一版」。 */
function entryName(entry: StripEntry): string {
  if (entry.kind === 'current') return '当前帧'
  if (entry.kind === 'image')
    return `${entry.job === null ? '上一版' : '结果'} · ${formatDateTime(entry.createdAt)}`
  const phase = phaseOfStatus(entry.job.status)
  const label = phase === 'completed' ? '结果' : PHASE_LABEL[phase]
  return `${label} · ${formatDateTime(entry.job.createdAt)}`
}

export function EditResultStrip({
  entries,
  selectedKey,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
}: EditResultStripProps) {
  return (
    <div aria-label="这一帧的图片" className="image-edit-strip" role="group">
      {entries.map((entry) => (
        <button
          aria-label={entryName(entry)}
          aria-pressed={entry.key === selectedKey}
          className={cn(
            'image-edit-slot ui-focus',
            entry.key === selectedKey && 'image-edit-slot-on',
          )}
          key={entry.key}
          onClick={() => onSelect(entry.key)}
          type="button"
        >
          {entry.kind === 'pending' || entry.kind === 'failed' ? (
            <span className="image-edit-slot-blank">
              <StatusBadge kind="image" status={phaseOfStatus(entry.job.status)} />
            </span>
          ) : (
            <img alt="" className="image-edit-slot-image" src={entry.url} />
          )}
          {entry.kind === 'current' ? <span className="image-edit-slot-flag">用着</span> : null}
        </button>
      ))}
      {hasMore ? (
        <button
          className="image-edit-slot image-edit-slot-more ui-focus"
          disabled={loadingMore}
          onClick={onLoadMore}
          type="button"
        >
          <Icon decorative name="loading" className={cn(loadingMore && 'animate-spin')} size="sm" />
          更早
        </button>
      ) : null}
    </div>
  )
}
