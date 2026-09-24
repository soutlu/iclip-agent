/** 图片或视频读不出来时的占位：一句主句，需要时补一行指引和一个重试。 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

type MediaFallbackKind = 'image' | 'video'

const MAIN: Record<MediaFallbackKind, string> = {
  image: '图片加载失败',
  video: '视频加载失败',
}

type MediaFallbackProps = {
  kind: MediaFallbackKind
  /** 主句之后的补充指引，说明这一处还能怎么办。 */
  hint?: string
  onRetry?: () => void
  /** 缩略图等窄格子里排成一行小字。 */
  compact?: boolean
  className?: string
}

/**
 * 渲染为 `<span>`，可以放进 `<button>`；播报语义由调用点的外壳决定，占位本身不做 live region。
 * 底色与定位也留给外壳，`className` 直接落在根元素上。
 */
export function MediaFallback({
  className,
  compact = false,
  hint,
  kind,
  onRetry,
}: MediaFallbackProps) {
  return (
    <span
      className={cn(
        'flex items-center justify-center text-center text-on-surface-variant',
        compact ? 'flex-wrap gap-x-2 gap-y-0.5 text-caption' : 'flex-col gap-2 text-body-sm',
        className,
      )}
    >
      <Icon decorative name={kind} size={compact ? 'sm' : 'lg'} />
      <span>{MAIN[kind]}</span>
      {hint === undefined ? null : (
        <span className={compact ? undefined : 'text-caption'}>{hint}</span>
      )}
      {onRetry === undefined ? null : (
        <Button onClick={onRetry} size="md" variant="tonal">
          重试
        </Button>
      )}
    </span>
  )
}
