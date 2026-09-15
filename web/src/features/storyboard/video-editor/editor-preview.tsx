import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'
import { toast } from '@/shared/ui/toast'
import { timelineSegments, durationOf, type EditorVersion } from './editor-model'

function timeLabel(time: number) {
  return `${Math.floor(time / 60)
    .toString()
    .padStart(2, '0')}:${(time % 60).toFixed(2).padStart(5, '0')}`
}
type Props = {
  videoUrl: string
  posterUrl: string | undefined
  version: EditorVersion | undefined
  currentTime: number
  onSeek: (time: number) => void
  onDuration: (duration: number) => void
  onPoster: (url: string) => void
}
export function EditorPreview({
  videoUrl,
  posterUrl,
  version,
  currentTime,
  onSeek,
  onDuration,
  onPoster,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef(currentTime)
  useEffect(() => {
    timeRef.current = currentTime
  }, [currentTime])
  const [original, setOriginal] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [failed, setFailed] = useState(false)
  const [ratio, setRatio] = useState('9:16')
  const duration = version ? durationOf(version) : 0
  const segments = version ? timelineSegments(version) : []
  const segment =
    segments.find((item) => currentTime >= item.currentStart && currentTime < item.currentEnd) ??
    segments.at(-1)
  const previousSourceEnd =
    segments
      .filter((item) => item.currentEnd <= (segment?.currentStart ?? 0) && item.sourceEnd !== null)
      .at(-1)?.sourceEnd ?? 0
  const noOriginal = segment?.sourceStart === null
  const mappedTime =
    segment?.sourceStart != null ? segment.sourceStart + (currentTime - segment.currentStart) : null

  // 本地 UI 候选仍使用原片素材；扩展段保持上一帧，真实编辑结果待接入后替换。
  useEffect(() => {
    const video = videoRef.current
    if (!video || video.readyState < 1 || !Number.isFinite(video.duration)) return
    const time = mappedTime ?? Math.max(0, previousSourceEnd - 0.04)
    const target = Math.min(video.duration - 0.04, Math.max(0, time))
    if (Math.abs(video.currentTime - target) > 0.08) video.currentTime = target
  }, [mappedTime, previousSourceEnd])

  useEffect(() => {
    if (!playing || duration === 0) return
    let frame = 0
    let last = performance.now()
    let clock = timeRef.current >= duration ? 0 : timeRef.current
    let emitted = timeRef.current
    const tick = (now: number) => {
      if (Math.abs(timeRef.current - emitted) > 0.05) clock = timeRef.current
      clock = Math.min(duration, clock + (now - last) / 1000)
      last = now
      emitted = clock
      onSeek(clock)
      if (clock >= duration) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, duration, onSeek])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!playing || noOriginal) {
      video.pause()
      return
    }
    void video.play().catch(() => {
      setPlaying(false)
      toast.error('无法播放视频，请重试')
    })
    return () => video.pause()
  }, [playing, noOriginal])

  return (
    <div className="ve-preview" ref={stageRef} aria-label="视频预览">
      <video
        aria-label="原视频播放器"
        className={cn('ve-video', original && noOriginal && 'invisible')}
        muted={muted}
        onError={() => {
          setFailed(true)
          setPlaying(false)
        }}
        onLoadedMetadata={(event) => {
          const media = event.currentTarget
          onDuration(media.duration)
          setRatio(media.videoWidth > media.videoHeight ? '16:9' : '9:16')
        }}
        onLoadedData={(event) => {
          if (posterUrl) return
          const media = event.currentTarget
          const canvas = document.createElement('canvas')
          canvas.width = 180
          canvas.height = Math.round((180 * media.videoHeight) / media.videoWidth)
          canvas.getContext('2d')?.drawImage(media, 0, 0, canvas.width, canvas.height)
          try {
            onPoster(canvas.toDataURL('image/jpeg', 0.75))
          } catch {
            /* 跨域视频仍可播放；受浏览器保护的帧不提取缩略图。 */
          }
        }}
        playsInline
        poster={posterUrl}
        preload="auto"
        ref={videoRef}
        src={videoUrl}
      >
        <track kind="captions" srcLang="zh" label="中文字幕" />
      </video>
      <div className="ve-preview-tabs" role="group" aria-label="预览版本">
        <button
          aria-pressed={original}
          className={cn('ve-preview-tab', original && 'is-active')}
          onClick={() => setOriginal(true)}
          type="button"
        >
          <Icon decorative name="video" size="sm" />
          原片
        </button>
        <button
          aria-pressed={!original}
          className={cn('ve-preview-tab', !original && 'is-active')}
          onClick={() => setOriginal(false)}
          type="button"
        >
          <Icon decorative name="video" size="sm" />
          {version?.label ?? '预览'}
        </button>
      </div>
      <span className="ve-ratio">{ratio}</span>
      {original && noOriginal ? (
        <div className="ve-preview-message">
          <Icon decorative name="video" size="lg" />
          <span>此处为新增片段，无对应原片</span>
        </div>
      ) : null}
      {failed ? (
        <div className="ve-preview-message" role="alert">
          <span>原视频加载失败</span>
          <button
            className="ve-text-button"
            type="button"
            onClick={() => {
              setFailed(false)
              videoRef.current?.load()
            }}
          >
            重新加载
          </button>
        </div>
      ) : null}
      <div className="ve-transport">
        <IconButton
          label="上一帧"
          name="frame-back"
          size="sm"
          disabled={!duration}
          onClick={() => {
            setPlaying(false)
            onSeek(Math.max(0, currentTime - 1 / 25))
          }}
        />
        <IconButton
          label={playing ? '暂停' : '播放'}
          name={playing ? 'pause' : 'play'}
          size="sm"
          disabled={!duration || failed}
          onClick={() => setPlaying(!playing)}
        />
        <IconButton
          label="下一帧"
          name="frame-next"
          size="sm"
          disabled={!duration}
          onClick={() => {
            setPlaying(false)
            onSeek(Math.min(duration, currentTime + 1 / 25))
          }}
        />
        <span className="ve-playback-time">
          {timeLabel(currentTime)} <span>/ {timeLabel(duration)}</span>
        </span>
        <IconButton
          label={muted ? '开启声音' : '静音'}
          name={muted ? 'audio-off' : 'audio'}
          size="sm"
          onClick={() => setMuted(!muted)}
        />
        <IconButton
          label="全屏预览"
          name="maximize-panel"
          size="sm"
          onClick={() => {
            void stageRef.current
              ?.requestFullscreen()
              .catch(() => toast.error('浏览器无法开启全屏'))
          }}
        />
      </div>
    </div>
  )
}
