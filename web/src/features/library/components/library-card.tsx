/** 资料库的一张卡：封面是按画幅占位的截帧小图；悬停片刻才挂视频预览、移开就卸掉，列表上平时不挂 <video>。 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'
import { Tag } from '@/shared/ui/tag'
import type { LibraryVideo } from '../library.api'
import { snapshotWidthFor } from '../library-layout'
import {
  aspectOf,
  cardTitleOf,
  cutCountOf,
  durationSecondsOf,
  formatClock,
  openingTextOf,
} from '../library-media'

/** 悬停停留这么久才开始下载预览，扫过网格时不触发。 */
const PREVIEW_DELAY_MS = 300

/** 能悬停、没要求减少动效、没开省流量时才自动预览；触屏点开详情看。 */
const canAutoPreview = (): boolean => {
  const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
  return (
    saveData !== true &&
    window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches
  )
}

const usePreviewIntent = () => {
  const [active, setActive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])
  return {
    active,
    onPointerEnter: () => {
      if (!canAutoPreview()) return
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setActive(true), PREVIEW_DELAY_MS)
    },
    onPointerLeave: () => {
      clearTimeout(timerRef.current)
      setActive(false)
    },
  }
}

type LibraryCardProps = {
  video: LibraryVideo
  /** 这一列的显示宽度，决定封面截多大。 */
  width: number
  onAuthor: (userName: string) => void
}

export function LibraryCard({ video, width, onAuthor }: LibraryCardProps) {
  const { face, take } = video
  const aspect = aspectOf(take.aspectRatio)
  // 列宽量出来之前不请求封面，免得先按占位宽度截一张、量完再截一张。
  const poster =
    width > 0
      ? videoSnapshotUrl(face.outputUrl, snapshotWidthFor(width, window.devicePixelRatio || 1))
      : null
  const preview = usePreviewIntent()
  const { copied, copy } = useCopyFeedback()
  const [posterLoaded, setPosterLoaded] = useState(false)
  // 窄列（手机两列）上角标放不下：结构角标只留镜数，模型标签不显示。
  const compact = width > 0 && width < 220
  const seconds = compact && cutCountOf(take) !== null ? null : durationSecondsOf(video)
  const cuts = cutCountOf(take)
  const title = cardTitleOf(video)
  const author = take.userName

  return (
    <article aria-label={title} className="library-card group flex flex-col">
      <div
        className="library-card-media relative overflow-hidden rounded-md bg-surface-container-low"
        onPointerEnter={preview.onPointerEnter}
        onPointerLeave={preview.onPointerLeave}
        style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}
      >
        {poster === null ? null : poster === undefined ? (
          // 不是 OSS 地址截不了帧，只放一个视频图标，悬停照样能预览。
          <span className="absolute inset-0 grid place-items-center text-on-surface-variant">
            <Icon decorative name="video" size="xl" />
          </span>
        ) : (
          <img
            alt=""
            className={cn(
              'library-card-poster absolute inset-0 size-full object-contain',
              posterLoaded && 'library-card-poster-loaded',
            )}
            decoding="async"
            loading="lazy"
            onLoad={() => setPosterLoaded(true)}
            src={poster}
          />
        )}
        {preview.active ? <PreviewVideo src={face.outputUrl} /> : null}

        <div className="pointer-events-none absolute top-2 left-2 flex gap-1.5">
          {face.kind === 'master' ? <Tag variant="success">成片</Tag> : null}
          {video.takeCount > 1 ? (
            <span className="library-card-badge">{video.takeCount} 版</span>
          ) : null}
        </div>
        {cuts === null && seconds === null ? null : (
          <span className="library-card-badge pointer-events-none absolute top-2 right-2">
            <Icon decorative name="grid" size="xs" />
            {cuts === null ? null : `${cuts} 镜`}
            {cuts !== null && seconds !== null ? (
              <span aria-hidden className="library-card-badge-divider" />
            ) : null}
            {seconds === null ? null : formatClock(seconds)}
          </span>
        )}
        {take.model === null || compact ? null : (
          <span className="library-card-badge library-card-hide-on-hover pointer-events-none absolute right-2 bottom-2">
            {take.model}
          </span>
        )}

        <div className="library-card-hover absolute inset-x-0 bottom-0 flex flex-col gap-2 px-2.5 pt-10 pb-2.5 text-on-scrim">
          <p className="line-clamp-3 text-body-sm">{openingTextOf(take)}</p>
          <div className="flex justify-end">
            <IconButton
              className="library-card-hover-button"
              label={copied ? '已复制完整提示词' : '复制完整提示词'}
              name={copied ? 'check' : 'copy'}
              onClick={() => void copy(take.prompt)}
              size="sm"
            />
          </div>
        </div>
      </div>

      <div className="px-0.5 pt-2.5">
        <h3 className="line-clamp-2 text-body font-medium text-on-surface">{title}</h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-body-sm text-on-surface-variant">
          {author === null ? null : (
            <button
              className="inline-flex min-w-0 ui-state items-center gap-1.5 rounded-full py-0.5 pr-1.5 ui-focus"
              onClick={() => onAuthor(author)}
              title={`只看 ${author} 的片子`}
              type="button"
            >
              <span
                aria-hidden
                className="grid size-4.5 shrink-0 place-items-center rounded-full bg-surface-container-high text-caption text-on-surface"
              >
                {Array.from(author)[0]?.toLocaleUpperCase()}
              </span>
              <span className="truncate">{author}</span>
            </button>
          )}
          <span className="shrink-0 text-on-surface-faint">
            {formatRelativeTime(face.createdAt)}
          </span>
        </div>
      </div>
    </article>
  )
}

/** 预览视频：挂上就静音循环播；卸载时清掉地址，浏览器随之中止下载、释放解码器。 */
function PreviewVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const element = ref.current
    return () => {
      if (element === null) return
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [])

  return (
    <>
      <video
        aria-hidden="true"
        autoPlay
        className={cn(
          'library-card-preview absolute inset-0 size-full object-contain',
          playing && 'library-card-preview-playing',
        )}
        loop
        muted
        onPlaying={() => setPlaying(true)}
        onTimeUpdate={(event) => {
          const { currentTime, duration } = event.currentTarget
          if (duration > 0) setProgress(currentTime / duration)
        }}
        playsInline
        preload="auto"
        ref={ref}
        src={src}
        tabIndex={-1}
      />
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 bg-on-scrim"
        style={{ width: `${progress * 100}%` }}
      />
    </>
  )
}
