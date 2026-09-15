import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import {
  durationOf,
  timelineSegments,
  type EditorVersion,
  type TimelineSegment,
} from './editor-model'
import './editor-timeline.css'

type TimeRange = { start: number; end: number }

type EditorTimelineProps = {
  version: EditorVersion
  versions: readonly EditorVersion[]
  posterUrl: string | undefined
  currentTime: number
  selection: TimeRange
  onSeek: (time: number) => void
  onSelectionChange: (range: TimeRange) => void
  onVersionChange: (id: string) => void
  onHistory: () => void
}

const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const

function clockLabel(time: number): string {
  const minutes = Math.floor(time / 60)
    .toString()
    .padStart(2, '0')
  const seconds = (time % 60).toFixed(2).padStart(5, '0')
  return `${minutes}:${seconds}`
}

function ancestorChain(
  version: EditorVersion,
  versions: readonly EditorVersion[],
): EditorVersion[] {
  const chain: EditorVersion[] = []
  const seen = new Set<string>()
  let current: EditorVersion | undefined = version
  while (current && !seen.has(current.id)) {
    chain.push(current)
    seen.add(current.id)
    const parentId: string | null = current.parentId
    current = versions.find((candidate) => candidate.id === parentId)
  }
  return chain.reverse()
}

function SegmentFrames({
  segment,
  posterUrl,
  zoom,
}: {
  segment: TimelineSegment
  posterUrl: string | undefined
  zoom: number
}) {
  if (!posterUrl) {
    return (
      <span className="editor-timeline-empty">
        <Icon decorative name="video" size="md" />
      </span>
    )
  }
  const count = Math.max(1, Math.min(48, Math.ceil((segment.duration * zoom) / 1.2)))
  const frames = Array.from({ length: count }, (_, index) => index / count)
  return (
    <span aria-hidden="true" className="editor-timeline-frames">
      {frames.map((offset) => (
        <img alt="" draggable={false} key={offset} src={posterUrl} />
      ))}
    </span>
  )
}

/** Compare a complete version with the original on the current version's playback clock. */
export function EditorTimeline({
  version,
  versions,
  posterUrl,
  currentTime,
  selection,
  onSeek,
  onSelectionChange,
  onVersionChange,
  onHistory,
}: EditorTimelineProps) {
  const [zoomIndex, setZoomIndex] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const duration = durationOf(version)
  const segments = timelineSegments(version)
  const lastMappedId = segments.filter((segment) => segment.sourceEnd !== null).at(-1)?.id
  const zoom = ZOOM_LEVELS[zoomIndex] ?? 1
  const ancestors = ancestorChain(version, versions)
  const original = ancestors.find((candidate) => candidate.parentId === null)
  const minimumRange = Math.min(0.1, duration)
  const boundedTime = Math.max(0, Math.min(duration, currentTime))
  const tickTarget = duration / (8 * zoom)
  const tickStep =
    [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 15, 30, 60].find((step) => step >= tickTarget) ??
    Math.ceil(tickTarget / 60) * 60
  const ticks = Array.from(
    { length: Math.ceil(duration / tickStep) },
    (_, index) => index * tickStep,
  ).filter((time) => time < duration - tickStep * 0.35)
  ticks.push(duration)

  const changeBoundary = (boundary: 'start' | 'end', value: number) => {
    const rounded = Math.round(value * 100) / 100
    onSelectionChange(
      boundary === 'start'
        ? {
            start: Math.max(0, Math.min(selection.end - minimumRange, rounded)),
            end: selection.end,
          }
        : {
            start: selection.start,
            end: Math.min(duration, Math.max(selection.start + minimumRange, rounded)),
          },
    )
  }

  const dragBoundary = (event: PointerEvent<HTMLButtonElement>, boundary: 'start' | 'end') => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const bounds = contentRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width === 0) return
    changeBoundary(boundary, ((event.clientX - bounds.left) / bounds.width) * duration)
  }

  const keyBoundary = (event: KeyboardEvent<HTMLButtonElement>, boundary: 'start' | 'end') => {
    const step = event.shiftKey ? 1 : 0.1
    const current = selection[boundary]
    const values: Record<string, number> = {
      ArrowLeft: current - step,
      ArrowDown: current - step,
      ArrowRight: current + step,
      ArrowUp: current + step,
      Home: boundary === 'start' ? 0 : selection.start + minimumRange,
      End: boundary === 'start' ? selection.end - minimumRange : duration,
    }
    const next = values[event.key]
    if (next === undefined) return
    event.preventDefault()
    changeBoundary(boundary, next)
  }

  return (
    <section aria-label="视频编辑时间线" className="editor-timeline">
      <header className="editor-timeline-toolbar">
        <div className="editor-timeline-heading">
          <h2>时间线</h2>
          <span>与原片对齐</span>
        </div>
        <div className="editor-timeline-tools">
          <select
            aria-label="时间线版本"
            className="editor-timeline-version ui-focus"
            onChange={(event) => onVersionChange(event.target.value)}
            value={version.id}
          >
            {versions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
          <IconButton
            disabled={zoomIndex === 0}
            label="缩小时间线"
            name="zoom-out"
            onClick={() => setZoomIndex((current) => Math.max(0, current - 1))}
            size="sm"
          />
          <IconButton
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            label="放大时间线"
            name="add"
            onClick={() => setZoomIndex((current) => Math.min(ZOOM_LEVELS.length - 1, current + 1))}
            size="sm"
          />
          <IconButton
            label="时间线适应宽度"
            name="maximize-panel"
            onClick={() => {
              setZoomIndex(0)
              contentRef.current?.parentElement?.scrollTo({ left: 0 })
            }}
            size="sm"
          />
        </div>
      </header>

      <div className="editor-timeline-viewport">
        <div aria-hidden="true" className="editor-timeline-labels">
          <div className="editor-timeline-ruler-spacer" />
          <div className="editor-timeline-track-label">
            <Icon decorative name="locked" size="md" />
            <div>
              <strong>原片</strong>
              <span>{original ? `${durationOf(original)}s` : '—'}</span>
            </div>
          </div>
          <div className="editor-timeline-track-label editor-timeline-current-label">
            <Icon decorative name="video" size="md" />
            <div>
              <strong>{version.label}</strong>
              <span>{Number(duration.toFixed(2))}s</span>
            </div>
          </div>
        </div>
        <div
          aria-label="时间线轨道，放大后可横向滚动"
          className="editor-timeline-scroll"
          role="region"
        >
          <div
            className="editor-timeline-content"
            ref={contentRef}
            style={{ minWidth: `${640 * zoom}px` }}
          >
            <div className="editor-timeline-ruler">
              {ticks.map((time) => (
                <span
                  aria-hidden="true"
                  className={cn('editor-timeline-tick', time === duration && 'is-last')}
                  key={time}
                  style={{ left: `${(time / duration) * 100}%` }}
                >
                  {Number(time.toFixed(2))}s
                </span>
              ))}
              <input
                aria-label="时间线播放位置"
                aria-valuetext={clockLabel(boundedTime)}
                className="editor-timeline-seek"
                max={duration}
                min={0}
                onChange={(event) => onSeek(Number(event.target.value))}
                step={0.01}
                type="range"
                value={boundedTime}
              />
            </div>

            <div
              aria-label="原片对应内容"
              className="editor-timeline-track editor-timeline-source-track"
            >
              {segments.map((segment) => (
                <div
                  className={cn(
                    'editor-timeline-source-segment',
                    segment.sourceStart === null && 'is-gap',
                  )}
                  key={segment.id}
                  style={{ width: `${(segment.duration / duration) * 100}%` }}
                  title={
                    segment.sourceStart === null
                      ? '新增内容，无对应原片'
                      : `原片 ${clockLabel(segment.sourceStart)} — ${clockLabel(segment.sourceEnd ?? segment.sourceStart)}`
                  }
                >
                  {segment.sourceStart === null ? (
                    <span className="editor-timeline-gap">无对应原片</span>
                  ) : (
                    <>
                      <SegmentFrames posterUrl={posterUrl} segment={segment} zoom={zoom} />
                      <span className="editor-timeline-source-time">
                        {Number(segment.sourceStart.toFixed(2))}s
                      </span>
                      {segment.id === lastMappedId && segment.sourceEnd !== null && (
                        <span className="editor-timeline-source-time is-end">
                          {Number(segment.sourceEnd.toFixed(2))}s
                        </span>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            <div
              aria-label={`${version.label} 完整视频`}
              className="editor-timeline-track editor-timeline-current-track"
            >
              {segments.map((segment) => {
                const originLabel = versions.find(
                  (candidate) => candidate.id === segment.originVersionId,
                )?.label
                const action =
                  segment.changeKind === 'extend'
                    ? `+${Number(segment.duration.toFixed(2))}s`
                    : '修改'
                const isSelected =
                  segment.currentStart === selection.start && segment.currentEnd === selection.end
                return (
                  <button
                    aria-label={`${segment.changeKind === 'original' ? '原片内容' : action} ${clockLabel(segment.currentStart)} 至 ${clockLabel(segment.currentEnd)}${originLabel ? `，来源 ${originLabel}` : ''}`}
                    aria-pressed={isSelected}
                    className={cn('editor-timeline-segment ui-focus', `is-${segment.changeKind}`)}
                    key={segment.id}
                    onClick={() => {
                      onSelectionChange({ start: segment.currentStart, end: segment.currentEnd })
                      onSeek(segment.currentStart)
                    }}
                    style={{ width: `${(segment.duration / duration) * 100}%` }}
                    title={segment.prompt}
                    type="button"
                  >
                    <SegmentFrames posterUrl={posterUrl} segment={segment} zoom={zoom} />
                    {segment.changeKind !== 'original' && (
                      <span className="editor-timeline-change-label">
                        {action}
                        {originLabel ? ` · ${originLabel}` : ''}
                      </span>
                    )}
                  </button>
                )
              })}
              <div
                className="editor-timeline-selection"
                style={{
                  left: `${(selection.start / duration) * 100}%`,
                  width: `${((selection.end - selection.start) / duration) * 100}%`,
                }}
              />
              {(['start', 'end'] as const).map((boundary) => (
                <button
                  aria-label={boundary === 'start' ? '选段开始时间' : '选段结束时间'}
                  aria-valuemax={boundary === 'start' ? selection.end - minimumRange : duration}
                  aria-valuemin={boundary === 'start' ? 0 : selection.start + minimumRange}
                  aria-valuenow={selection[boundary]}
                  aria-valuetext={clockLabel(selection[boundary])}
                  className={cn('editor-timeline-handle ui-focus', `is-${boundary}`)}
                  key={boundary}
                  onKeyDown={(event) => keyBoundary(event, boundary)}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.currentTarget.focus()
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                  onPointerMove={(event) => dragBoundary(event, boundary)}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(event.pointerId)
                  }}
                  role="slider"
                  style={{ left: `${(selection[boundary] / duration) * 100}%` }}
                  title={`${boundary === 'start' ? '开始' : '结束'} ${clockLabel(selection[boundary])}；方向键微调，Shift 加速`}
                  type="button"
                >
                  <span />
                </button>
              ))}
            </div>
            <div
              aria-hidden="true"
              className="editor-timeline-playhead"
              style={{ left: `${(boundedTime / duration) * 100}%` }}
            >
              <span
                className={cn(
                  boundedTime / duration < 0.08 && 'at-start',
                  boundedTime / duration > 0.92 && 'at-end',
                )}
              >
                {clockLabel(boundedTime)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <footer className="editor-timeline-footer">
        <div className="editor-timeline-legend">
          <span className="is-modify">修改</span>
          <span className="is-extend">延长</span>
        </div>
        <nav aria-label="当前版本来源" className="editor-timeline-ancestors">
          {ancestors.map((ancestor) => (
            <span className="editor-timeline-ancestor" key={ancestor.id}>
              <button
                aria-current={ancestor.id === version.id ? 'step' : undefined}
                className="ui-focus"
                onClick={() => onVersionChange(ancestor.id)}
                type="button"
              >
                {ancestor.label}
              </button>
              {ancestor.id !== version.id && <Icon decorative name="next" size="sm" />}
            </span>
          ))}
        </nav>
        <Button leadingIcon="history" onClick={onHistory} size="md" variant="ghost">
          历史
        </Button>
      </footer>
    </section>
  )
}
