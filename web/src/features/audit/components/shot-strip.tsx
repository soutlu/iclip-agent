/** 一段对话的镜头带：每镜一组点，点数即出片次数，只出一条且成了的镜（一次通过）点上加环。 */

import { cn } from '@/shared/lib/utils'
import type { ConversationReport } from '../audit.api'
import { formatDuration } from '../format'

type ShotStripProps = {
  shots: ConversationReport['shots']
  retryOver?: number
}

const MAX_DOTS = 6
/**
 * 单镜出片超过几次算重试过多；与后端异常判定 `Thresholds.retry_over` 的默认值同义
 * （server/src/iclip/domains/audit/models.py），判定同为出片次数大于它。
 */
const DEFAULT_RETRY_OVER = 2

export function ShotStrip({ shots, retryOver = DEFAULT_RETRY_OVER }: ShotStripProps) {
  if (shots.length === 0) {
    return <p className="text-body-sm text-on-surface-variant">这段对话没有带镜号的出片</p>
  }
  return (
    <ul aria-label="镜头出片次数" className="flex flex-wrap gap-x-5 gap-y-2">
      {shots.map((shot) => {
        const attempts = Math.min(shot.attempts, MAX_DOTS)
        const overflow = shot.attempts - attempts
        const excessive = shot.attempts > retryOver
        const spent = new Date(shot.lastAt).getTime() - new Date(shot.firstAt).getTime()
        return (
          <li
            aria-label={`第 ${shot.shot} 镜，出了 ${shot.attempts} 次，${shot.oneTake ? '一次通过' : '没有一次通过'}`}
            className="flex items-center gap-2"
            key={shot.shot}
            title={
              shot.attempts > 1
                ? `从第一次到最后一次隔了 ${formatDuration(spent / 1000)}`
                : undefined
            }
          >
            <span className="text-body-sm text-on-surface-variant tabular-nums">
              镜 {shot.shot}
            </span>
            <span aria-hidden className="flex items-center gap-1">
              {Array.from({ length: attempts }, (_, index) => {
                const isLast = index === attempts - 1 && overflow === 0
                return (
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      isLast
                        ? shot.oneTake || !excessive
                          ? 'bg-primary'
                          : 'bg-error'
                        : 'bg-outline-variant',
                      isLast && shot.oneTake && 'ring-2 ring-primary-container',
                    )}
                    key={index}
                  />
                )
              })}
              {overflow > 0 ? (
                <span className="text-caption text-on-surface-variant tabular-nums">
                  +{overflow}
                </span>
              ) : null}
            </span>
            <span
              className={cn(
                'text-body-sm tabular-nums',
                excessive ? 'font-medium text-error' : 'text-on-surface-variant',
              )}
            >
              {shot.attempts} 次
            </span>
          </li>
        )
      })}
    </ul>
  )
}
