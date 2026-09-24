/** 预览台：「原片」与当前版本两个 tab、播放控件、比例角标。
 *
 * 多段预览靠两个 `<video>` 轮换：一个在放、另一个预载下一段，到点切过去不用等加载。
 * 中间版本不落文件，拼好的整条只在这里连着放。 */

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { toast } from '@/shared/ui/toast'
import { locateClock, totalDuration, type LaidOutSegment } from './edit-chain'
import { timeLabel } from './time-label'
import type { TimeRange } from './time-range'

export type EditorPreviewHandle = {
  /** 暂停并切回当前编辑版本；右边界显示区间内侧的画面，游标仍标记准确边界。 */
  previewAt: (clock: number, boundary?: keyof TimeRange) => void
}

type Slot = 0 | 1
const SLOTS: readonly { id: string; slot: Slot }[] = [
  { id: 'a', slot: 0 },
  { id: 'b', slot: 1 },
]

/** 到段尾前多少秒就切下一段；rAF 一帧约 16ms，留两帧余量。 */
const SWITCH_AHEAD = 0.03
const FRAME_STEP = 1 / 25
/** 右开区间的定位偏移，仅避免跳进下一段，不代表素材的帧时长。 */
const END_PREVIEW_OFFSET = 0.001

type Props = {
  /** 当前看的这一版（或拼好的编辑预览）；`undefined` 是素材时长还没读到。换选中项时换一个新数组。 */
  current: readonly LaidOutSegment[] | undefined
  currentLabel: string
  /** 它基于的那一版，「原片」tab 放它；选的就是根时没有。 */
  original: readonly LaidOutSegment[] | undefined
  poster: string | undefined
  currentTime: number
  /** 当前版本的选区；null 时完整播放，原片对比不使用这个范围。 */
  selection: TimeRange | null
  onTime: (clock: number) => void
  ref: Ref<EditorPreviewHandle>
}

export function EditorPreview({
  current,
  currentLabel,
  original,
  poster,
  currentTime,
  selection,
  onTime,
  ref,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const elementsRef = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null])
  // 元数据还没到就先记下要跳到哪；同一槽只留最后一次，旧的跳转不会在加载完之后倒回去。
  const pendingSeekRef = useRef<[number | null, number | null]>([null, null])
  // 切源后应用最新定位；段列表身份防止旧请求落到另一个版本。
  const pendingPreviewRef = useRef<{
    segments: readonly LaidOutSegment[]
    clock: number
    boundary: keyof TimeRange | undefined
  } | null>(null)
  // 拖动开始时同步撤销播放，不必等下一次 render 的 effect 清理。
  const stopPlaybackRef = useRef<(() => void) | null>(null)
  // 效果里报时钟走的是它，拿到的永远是最新的 onTime；事件处理器里直接调 onTime。
  const emitTime = useEffectEvent((clock: number) => onTime(clock))
  const [showOriginal, setShowOriginal] = useState(false)
  const [active, setActive] = useState<Slot>(0)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [failed, setFailed] = useState(false)
  // 画面宽高比：角标文案与播放胶囊避让黑边都用它，元数据到达前按竖版算。
  const [aspect, setAspect] = useState(9 / 16)
  const onOriginal = showOriginal && original !== undefined
  const segments = onOriginal ? original : current
  const duration = segments === undefined ? 0 : totalDuration(segments)
  const playbackRange = !onOriginal && selection !== null ? selection : { start: 0, end: duration }
  // 选区显示到百分之一秒，末端可能被四舍五入到真实时长之外。
  const playbackStart = Math.min(duration, playbackRange.start)
  const playbackEnd = Math.min(duration, playbackRange.end)
  // 换了一组段就回到开头：播放位置是跟着段列表走的派生状态，在渲染里对齐，不等一帧。
  const [shown, setShown] = useState(segments)
  if (shown !== segments) {
    setShown(segments)
    setPlaying(false)
    setFailed(false)
    setActive(0)
    setIndex(0)
  }

  /** 把一段装进某个槽并跳到段内 `offset`；`reload` 是加载失败后重来。 */
  const load = useCallback(
    (slot: Slot, segment: LaidOutSegment, offset: number, reload = false) => {
      const element = elementsRef.current[slot]
      if (element === null) return
      const target = segment.start + offset
      if (reload || element.dataset['src'] !== segment.mediaUrl) {
        element.dataset['src'] = segment.mediaUrl
        pendingSeekRef.current[slot] = target
        element.src = segment.mediaUrl
      } else if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
        element.currentTime = target
      } else {
        pendingSeekRef.current[slot] = target
      }
    },
    [],
  )

  const seek = (clock: number, boundary?: keyof TimeRange) => {
    if (segments === undefined) return
    const boundedClock = Math.min(duration, Math.max(0, clock))
    const mediaClock =
      boundary === 'end' ? Math.max(0, boundedClock - END_PREVIEW_OFFSET) : boundedClock
    const located = locateClock(segments, mediaClock)
    const segment = located === undefined ? undefined : segments[located.index]
    if (located === undefined || segment === undefined) return
    if (located.index !== index) setIndex(located.index)
    load(active, segment, located.offset)
    onTime(boundedClock)
  }
  const seekFromEffect = useEffectEvent(seek)

  const pause = () => {
    // 先撤销这一轮播放，再 pause，避免未完成的 play() 被中断后误报加载失败。
    stopPlaybackRef.current?.()
    for (const element of elementsRef.current) element?.pause()
    setPlaying(false)
  }

  useImperativeHandle(ref, () => ({
    previewAt(clock, boundary) {
      pause()
      if (current === undefined) return
      if (onOriginal) {
        pendingPreviewRef.current = { segments: current, clock, boundary }
        setShowOriginal(false)
      } else {
        seek(clock, boundary)
      }
    },
  }))

  // 切源默认回到开头；从原片切回编辑版本时，先应用最后一次边界定位。
  useEffect(() => {
    const pending = pendingPreviewRef.current
    pendingPreviewRef.current = null
    if (segments === undefined) {
      emitTime(0)
      return
    }
    if (pending !== null && pending.segments === segments) {
      seekFromEffect(pending.clock, pending.boundary)
    } else {
      seekFromEffect(0)
    }
  }, [segments])

  // 主槽换段之后，把再下一段预载进腾出来的那个槽。
  useEffect(() => {
    const next = segments?.[index + 1]
    if (next !== undefined) load(active === 0 ? 1 : 0, next, 0)
  }, [segments, index, active, load])

  useEffect(() => {
    const element = elementsRef.current[active]
    const segment = segments?.[index]
    if (element === null || segments === undefined || segment === undefined || !playing) return

    let cancelled = false
    let frame = 0
    const stop = () => {
      cancelled = true
      cancelAnimationFrame(frame)
      element.pause()
      if (stopPlaybackRef.current === stop) stopPlaybackRef.current = null
    }
    stopPlaybackRef.current = stop
    void element.play().catch(() => {
      if (cancelled) return
      stop()
      setPlaying(false)
      setFailed(true)
    })

    const tick = () => {
      if (cancelled) return
      const now = element.currentTime
      const clock = segment.at + Math.min(segment.duration, Math.max(0, now - segment.start))
      const segmentEnd = segment.at + segment.duration
      if (
        clock >= playbackEnd ||
        (element.ended && (playbackEnd <= segmentEnd || index === segments.length - 1))
      ) {
        stop()
        setPlaying(false)
        seekFromEffect(playbackEnd, 'end')
        return
      }
      emitTime(clock)
      // 选段终点在本段内时继续等到终点，不能被提前换段逻辑带到下一段。
      if (segmentEnd < playbackEnd && (element.ended || now >= segment.end - SWITCH_AHEAD)) {
        stop()
        setActive(active === 0 ? 1 : 0)
        setIndex(index + 1)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return stop
  }, [playing, index, active, segments, playbackEnd])

  const step = (direction: 1 | -1) => {
    pause()
    const clock = Math.min(
      playbackEnd,
      Math.max(playbackStart, currentTime + direction * FRAME_STEP),
    )
    seek(clock, clock === playbackEnd ? 'end' : undefined)
  }

  return (
    <div
      aria-label="视频预览"
      className="video-editor-preview"
      ref={stageRef}
      style={{ '--preview-ratio': aspect } as CSSProperties}
    >
      {SLOTS.map(({ id, slot }) => (
        // eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成的视频没有字幕轨，不装样子
        <video
          aria-hidden={slot !== active}
          aria-label={slot === active ? '视频播放器' : undefined}
          className={cn('video-editor-video', slot !== active && 'invisible')}
          key={id}
          muted={muted}
          onError={() => {
            if (slot === active) {
              setFailed(true)
              setPlaying(false)
            }
          }}
          onLoadedMetadata={(event) => {
            const media = event.currentTarget
            if (slot === active && media.videoWidth > 0 && media.videoHeight > 0) {
              setAspect(media.videoWidth / media.videoHeight)
            }
            const target = pendingSeekRef.current[slot]
            if (target === null) return
            pendingSeekRef.current[slot] = null
            media.currentTime = target
          }}
          playsInline
          poster={slot === 0 ? poster : undefined}
          preload="auto"
          ref={(element) => {
            elementsRef.current[slot] = element
          }}
        />
      ))}
      <div aria-label="预览版本" className="video-editor-preview-tabs" role="group">
        <button
          aria-pressed={onOriginal || original === undefined}
          className={cn(
            'video-editor-preview-tab',
            (onOriginal || original === undefined) && 'is-active',
          )}
          disabled={original === undefined}
          onClick={() => {
            pause()
            setShowOriginal(true)
          }}
          type="button"
        >
          <Icon decorative name="video" size="sm" />
          原片
        </button>
        {original === undefined ? null : (
          <button
            aria-pressed={!onOriginal}
            className={cn('video-editor-preview-tab', !onOriginal && 'is-active')}
            onClick={() => {
              pause()
              setShowOriginal(false)
            }}
            type="button"
          >
            <Icon decorative name="video" size="sm" />
            {currentLabel}
          </button>
        )}
      </div>
      <span className="video-editor-ratio">{aspect > 1 ? '16:9' : '9:16'}</span>
      {segments === undefined ? (
        <div className="video-editor-preview-message" role="status">
          <Icon decorative name="video" size="lg" />
          <span>正在读取视频信息…</span>
        </div>
      ) : null}
      {failed ? (
        <div className="video-editor-preview-message" role="alert">
          <MediaFallback
            kind="video"
            onRetry={() => {
              setFailed(false)
              const segment = segments?.[index]
              if (segment !== undefined) load(active, segment, 0, true)
            }}
          />
        </div>
      ) : null}
      <div aria-label="播放控件" className="video-editor-transport" role="group">
        <IconButton
          disabled={segments === undefined}
          label="上一帧"
          name="frame-back"
          onClick={() => step(-1)}
          size="sm"
        />
        <IconButton
          disabled={segments === undefined || failed}
          label={playing ? '暂停' : '播放'}
          name={playing ? 'pause' : 'play'}
          onClick={() => {
            if (playing) {
              pause()
              return
            }
            if (currentTime < playbackStart || currentTime >= playbackEnd) seek(playbackStart)
            setPlaying(true)
          }}
          size="sm"
        />
        <IconButton
          disabled={segments === undefined}
          label="下一帧"
          name="frame-next"
          onClick={() => step(1)}
          size="sm"
        />
        <span className="video-editor-playback-time">
          {timeLabel(currentTime)} <span>/ {timeLabel(duration)}</span>
        </span>
        <IconButton
          label={muted ? '开启声音' : '静音'}
          name={muted ? 'audio-off' : 'audio'}
          onClick={() => setMuted(!muted)}
          size="sm"
        />
        <IconButton
          label="全屏预览"
          name="maximize-panel"
          onClick={() => {
            void stageRef.current
              ?.requestFullscreen()
              .catch(() => toast.error('浏览器无法开启全屏'))
          }}
          size="sm"
        />
      </div>
    </div>
  )
}
