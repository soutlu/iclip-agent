/** 资料库的一张卡：封面是按画幅占位的截帧小图；悬停片刻才挂视频预览、移开就卸掉，列表上平时不挂 <video>。
 *
 * 点画面进详情；右上角的结构角标是故事板入口，指着某一帧时预览画面跳到那一镜。 */

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
import { aspectOf, cardTitleOf, durationSecondsOf, openingTextOf } from '../library-media'
import { AuthorAvatar } from './author-avatar'
import { StoryboardBadge } from './library-storyboard'

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
  /** 进详情；从故事板点某一帧进来时带上起播秒数。 */
  onOpen: (id: string, startAt: number | null) => void
}

export function LibraryCard({ video, width, onAuthor, onOpen }: LibraryCardProps) {
  const { face, take } = video
  const aspect = aspectOf(take.aspectRatio)
  // 列宽量出来之前不请求封面，免得先按占位宽度截一张、量完再截一张。
  const poster =
    width > 0
      ? videoSnapshotUrl(face.outputUrl, snapshotWidthFor(width, window.devicePixelRatio || 1))
      : null
  const preview = usePreviewIntent()
  // 故事板里正对准的那一刻；故事板收起时是 null。指针移到浮层上已离开画面，预览照样留着。
  const [storyboardAt, setStoryboardAt] = useState<number | null>(null)
  const showPreview = preview.active || (storyboardAt !== null && canAutoPreview())
  const { copied, copy } = useCopyFeedback()
  const [posterLoaded, setPosterLoaded] = useState(false)
  // 窄列（手机两列）上角标放不下：结构角标只留镜数，模型标签不显示。
  const compact = width > 0 && width < 220
  const seconds = durationSecondsOf(face.durationMs, take)
  const title = cardTitleOf(video)
  const author = video.userName

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
        {showPreview ? <PreviewVideo seekTo={storyboardAt} src={face.outputUrl} /> : null}
        <button
          aria-label={`查看详情：${title}`}
          className="absolute inset-0 cursor-pointer rounded-md ui-focus"
          data-open-video={video.id}
          onClick={() => onOpen(video.id, null)}
          type="button"
        />

        <div className="pointer-events-none absolute top-2 left-2 flex gap-1.5">
          {face.kind === 'composite' ? <Tag variant="success">合成</Tag> : null}
          {video.groupCount > 1 ? (
            <span className="library-card-badge">{video.groupCount} 组</span>
          ) : null}
          {video.versionCount > 1 ? (
            <span className="library-card-badge">{video.versionCount} 版</span>
          ) : null}
        </div>
        <StoryboardBadge
          compact={compact}
          onFocusFrame={setStoryboardAt}
          onPickFrame={(at) => onOpen(video.id, at)}
          seconds={seconds}
          video={video}
        />
        {take.model === null || compact ? null : (
          <span className="library-card-badge library-card-hide-on-hover pointer-events-none absolute right-2 bottom-2">
            {take.model}
          </span>
        )}

        {/* 悬停层不接点击，点它等于点画面；只有复制按钮自己接。 */}
        <div className="library-card-hover pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 px-2.5 pt-10 pb-2.5 text-on-scrim">
          <p className="line-clamp-3 text-body-sm">{openingTextOf(take)}</p>
          <div className="flex justify-end">
            <IconButton
              className="library-card-hover-button pointer-events-auto"
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
              <AuthorAvatar className="size-4.5 text-caption" name={author} />
              <span className="truncate">{author}</span>
            </button>
          )}
          <span className="shrink-0 text-on-surface-faint">
            {formatRelativeTime(face.finishedAt)}
          </span>
        </div>
      </div>
    </article>
  )
}

/** 预览视频：挂上就静音循环播；给了 `seekTo` 就停在那一刻，收回后接着播。卸载时清掉地址，浏览器随之中止下载、释放解码器。 */
function PreviewVideo({ src, seekTo }: { src: string; seekTo: number | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [shown, setShown] = useState(false)
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

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    if (seekTo !== null) {
      element.pause()
      element.currentTime = seekTo
    } else if (element.paused && element.currentTime > 0) {
      // 故事板收起、指针还在画面上：从停下的地方接着播。
      void element.play().catch(() => undefined)
    }
  }, [seekTo])

  return (
    <>
      <video
        aria-hidden="true"
        autoPlay
        className={cn(
          'library-card-preview absolute inset-0 size-full object-contain',
          shown && 'library-card-preview-playing',
        )}
        loop
        muted
        onPlaying={() => setShown(true)}
        // 故事板一挂上就停在某一帧，不经过播放，跳到位也算能看了。
        onSeeked={() => setShown(true)}
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
