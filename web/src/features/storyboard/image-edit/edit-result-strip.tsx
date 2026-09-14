/** 这一帧出现过的图，挂在画布下沿。只画调用方给的条目，不查数据。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { cn } from '@/shared/lib/utils'
import { phaseOfStatus } from '../shots'
import { entryBaseUrl, type StripEntry } from './edit-history'
import { editTaskLook } from './edit-task-status'

type EditResultStripProps = {
  entries: readonly StripEntry[]
  currentUrl: string
  /** 上传、提交、应用期间锁住整条：这几段窗口里换底图会把结果写进上一张图的草稿。 */
  disabled: boolean
  selectedKey: string
  onSelect: (key: string) => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  actions?: ReactNode
}

/** 只有还没落地的任务才占独立一格；完成的任务已经变成它产出的那张图。 */
const PHASE_LABEL: Record<'failed' | 'queued' | 'running', string> = {
  failed: '失败',
  queued: '排队中',
  running: '生成中',
}

/** 没有关联任务的图片曾作为别次编辑的底图保留下来，称为「上一版」。 */
function entryLabel(entry: StripEntry): string {
  if (entry.kind === 'current') return '当前帧'
  if (entry.kind === 'image') return entry.job === null ? '上一版' : '结果'
  const phase = phaseOfStatus(entry.job.status)
  return phase === 'completed' ? '结果' : PHASE_LABEL[phase]
}

/** 用时间补充可访问名，区分同一种状态的多条记录。 */
function entryName(entry: StripEntry): string {
  if (entry.kind === 'current') return entryLabel(entry)
  const createdAt = entry.kind === 'image' ? entry.createdAt : entry.job.createdAt
  return `${entryLabel(entry)} · ${formatDateTime(createdAt)}`
}

export function EditResultStrip({
  entries,
  currentUrl,
  disabled,
  selectedKey,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
  actions,
}: EditResultStripProps) {
  return (
    <div className="image-edit-history">
      <div aria-label="这一帧的图片" className="image-edit-strip" role="group">
        {entries.map((entry) => {
          const look =
            entry.kind === 'pending' || entry.kind === 'failed' ? editTaskLook(entry) : null
          return (
            <button
              aria-label={entryName(entry)}
              aria-pressed={entry.key === selectedKey}
              className="image-edit-entry ui-focus"
              disabled={disabled}
              key={entry.key}
              onClick={() => onSelect(entry.key)}
              type="button"
              title={entryName(entry)}
            >
              <span
                className={cn('image-edit-slot', entry.key === selectedKey && 'image-edit-slot-on')}
              >
                <img
                  alt=""
                  className="image-edit-slot-image"
                  src={entryBaseUrl(entry, currentUrl)}
                  loading="lazy"
                />
                {look ? (
                  <span className="image-edit-slot-state">
                    <Icon
                      className={cn(look.tone, look.spin && 'motion-safe:animate-spin')}
                      decorative
                      name={look.icon}
                      size="lg"
                    />
                  </span>
                ) : null}
              </span>
              <span className="image-edit-entry-label">{entryLabel(entry)}</span>
            </button>
          )
        })}
        {hasMore ? (
          <button
            className="image-edit-entry image-edit-slot-more ui-focus"
            disabled={disabled || loadingMore}
            onClick={onLoadMore}
            type="button"
          >
            <Icon
              decorative
              name={loadingMore ? 'loading' : 'history'}
              className={cn(loadingMore && 'motion-safe:animate-spin')}
              size="sm"
            />
            更早
          </button>
        ) : null}
      </div>
      {actions ? <div className="image-edit-history-actions">{actions}</div> : null}
    </div>
  )
}
