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
  type Ref,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'
import { locateClock, totalDuration, type LaidOutSegment } from './edit-chain'
import { timeLabel } from './time-label'

export type EditorPreviewHandle = { seek: (clock: number) => void }

type Slot = 0 | 1
const SLOTS: readonly { id: string; slot: Slot }[] = [
  { id: 'a', slot: 0 },
  { id: 'b', slot: 1 },
]

/** 到段尾前多少秒就切下一段；rAF 一帧约 16ms，留两帧余量。 */
const SWITCH_AHEAD = 0.03
const FRAME_STEP = 1 / 25

type Props = {
  /** 当前看的这一版（或拼好的编辑预览）；`undefined` 是素材时长还没读到。换选中项时换一个新数组。 */
  current: readonly LaidOutSegment[] | undefined
  currentLabel: string
  /** 它基于的那一版，「原片」tab 放它；选的就是根时没有。 */
  original: readonly LaidOutSegment[] | undefined
  poster: string | undefined
  currentTime: number
  onTime: (clock: number) => void
  ref: Ref<EditorPreviewHandle>
}

export function EditorPreview({
  current,
  currentLabel,
  original,
  poster,
  currentTime,
  onTime,
  ref,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const elementsRef = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null])
  // 元数据还没到就先记下要跳到哪；同一槽只留最后一次，旧的跳转不会在加载完之后倒回去。
  const pendingSeekRef = useRef<[number | null, number | null]>([null, null])
  // 效果里报时钟走的是它，拿到的永远是最新的 onTime；事件处理器里直接调 onTime。
  const emitTime = useEffectEvent((clock: number) => onTime(clock))
  const [showOriginal, setShowOriginal] = useState(false)
  const [active, setActive] = useState<Slot>(0)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [failed, setFailed] = useState(false)
  const [ratio, setRatio] = useState('9:16')
  const onOriginal = showOriginal && original !== undefined
  const segments = onOriginal ? original : current
  const duration = segments === undefined ? 0 : totalDuration(segments)
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

  // 换了一组段：主槽装第一段，副槽预载第二段。
  useEffect(() => {
    emitTime(0)
    if (segments?.[0] !== undefined) load(0, segments[0], 0)
    if (segments?.[1] !== undefined) load(1, segments[1], 0)
  }, [segments, load])

  // 主槽换段之后，把再下一段预载进腾出来的那个槽。
  useEffect(() => {
    const next = segments?.[index + 1]
    if (next !== undefined) load(active === 0 ? 1 : 0, next, 0)
  }, [segments, index, active, load])

  useEffect(() => {
    const element = elementsRef.current[active]
    const segment = segments?.[index]
    if (element === null || segment === undefined) return
    if (!playing) {
      element.pause()
      return
    }
    void element.play().catch(() => {
      setPlaying(false)
      setFailed(true)
    })
    let frame = 0
    const tick = () => {
      const now = element.currentTime
      emitTime(segment.at + Math.min(segment.duration, Math.max(0, now - segment.start)))
      if (element.ended || now >= segment.end - SWITCH_AHEAD) {
        const next = index + 1
        if (segments === undefined || next >= segments.length) {
          setPlaying(false)
          emitTime(duration)
        } else {
          setActive(active === 0 ? 1 : 0)
          setIndex(next)
        }
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      element.pause()
    }
  }, [playing, index, active, segments, duration])

  const seek = (clock: number) => {
    if (segments === undefined) return
    const located = locateClock(segments, clock)
    const segment = located === undefined ? undefined : segments[located.index]
    if (located === undefined || segment === undefined) return
    if (located.index !== index) setIndex(located.index)
    load(active, segment, located.offset)
    onTime(Math.min(duration, Math.max(0, clock)))
  }
  useImperativeHandle(ref, () => ({ seek }))

  const step = (direction: 1 | -1) => {
    setPlaying(false)
    seek(currentTime + direction * FRAME_STEP)
  }

  return (
    <div aria-label="视频预览" className="video-editor-preview" ref={stageRef}>
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
            if (slot === active) setRatio(media.videoWidth > media.videoHeight ? '16:9' : '9:16')
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
          onClick={() => setShowOriginal(true)}
          type="button"
        >
          <Icon decorative name="video" size="sm" />
          原片
        </button>
        {original === undefined ? null : (
          <button
            aria-pressed={!onOriginal}
            className={cn('video-editor-preview-tab', !onOriginal && 'is-active')}
            onClick={() => setShowOriginal(false)}
            type="button"
          >
            <Icon decorative name="video" size="sm" />
            {currentLabel}
          </button>
        )}
      </div>
      <span className="video-editor-ratio">{ratio}</span>
      {segments === undefined ? (
        <div className="video-editor-preview-message" role="status">
          <Icon decorative name="video" size="lg" />
          <span>正在读取视频信息…</span>
        </div>
      ) : null}
      {failed ? (
        <div className="video-editor-preview-message" role="alert">
          <span>视频加载失败</span>
          <button
            className="video-editor-text-button"
            onClick={() => {
              setFailed(false)
              const segment = segments?.[index]
              if (segment !== undefined) load(active, segment, 0, true)
            }}
            type="button"
          >
            重新加载
          </button>
        </div>
      ) : null}
      <div className="video-editor-transport">
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
            if (!playing && currentTime >= duration) seek(0)
            setPlaying(!playing)
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
