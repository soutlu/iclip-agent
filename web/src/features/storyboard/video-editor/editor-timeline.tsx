/** 时间线：上轨是基底里对应的内容，下轨是当前这一版；在版本上拖手柄选段，方向键微调。 */

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import type { ChainVersion, LaidOutSegment } from './edit-chain'
import { EditorVersionMenu, type VersionMenuEntry } from './editor-version-menu'
import { roundSeconds, timeLabel } from './time-label'
import { MIN_RANGE_SECONDS, type TimeRange } from './time-range'
import './editor-timeline.css'

const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 15, 30, 60]

type EditorTimelineProps = {
  /** 当前看的这一版叫什么。 */
  label: string
  segments: readonly LaidOutSegment[]
  duration: number
  /** 它基于哪一版；根没有。 */
  base: ChainVersion | undefined
  baseDuration: number | undefined
  /** 版本菜单里能选的：各版与已能预览的编辑。 */
  entries: readonly VersionMenuEntry[]
  selectedKey: string
  /** 从根到当前版本的来源链。 */
  ancestors: readonly ChainVersion[]
  posterOf: (url: string) => string | undefined
  currentTime: number
  /** 空表示看的是编辑预览，不能在上面选段。 */
  selection: TimeRange | null
  onSeek: (time: number) => void
  onSelectionChange: (range: TimeRange, boundary: keyof TimeRange) => void
  onSelect: (key: string) => void
  onHistory: () => void
}

function SegmentFrames({ poster, count }: { poster: string | undefined; count: number }) {
  if (poster === undefined) {
    return (
      <span className="video-editor-timeline-empty">
        <Icon decorative name="video" size="md" />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className="video-editor-timeline-frames">
      {Array.from({ length: count }, (_, at) => (
        <img alt="" draggable={false} key={at} src={poster} />
      ))}
    </span>
  )
}

export function EditorTimeline({
  label,
  segments,
  duration,
  base,
  baseDuration,
  entries,
  selectedKey,
  ancestors,
  posterOf,
  currentTime,
  selection,
  onSeek,
  onSelectionChange,
  onSelect,
  onHistory,
}: EditorTimelineProps) {
  const [zoomIndex, setZoomIndex] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const zoom = ZOOM_LEVELS[zoomIndex] ?? 1
  const boundedTime = Math.max(0, Math.min(duration, currentTime))
  const lastBase = segments.filter((segment) => segment.role === 'base').at(-1)
  const tickTarget = duration / (8 * zoom)
  const tickStep = TICK_STEPS.find((step) => step >= tickTarget) ?? Math.ceil(tickTarget / 60) * 60
  const ticks = Array.from(
    { length: Math.ceil(duration / tickStep) },
    (_, at) => at * tickStep,
  ).filter((time) => time < duration - tickStep * 0.35)
  ticks.push(duration)
  const percent = (time: number) => `${(time / duration) * 100}%`
  const frameCount = (segment: LaidOutSegment) =>
    Math.max(1, Math.min(48, Math.ceil((segment.duration * zoom) / 1.2)))

  const changeBoundary = (boundary: keyof TimeRange, value: number) => {
    if (selection === null) return
    onSelectionChange({ ...selection, [boundary]: value }, boundary)
  }

  const dragBoundary = (event: PointerEvent<HTMLButtonElement>, boundary: keyof TimeRange) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const bounds = contentRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.width === 0) return
    changeBoundary(boundary, ((event.clientX - bounds.left) / bounds.width) * duration)
  }

  const keyBoundary = (event: KeyboardEvent<HTMLButtonElement>, boundary: keyof TimeRange) => {
    if (selection === null) return
    const step = event.shiftKey ? 1 : 0.1
    const current = selection[boundary]
    const targets: Record<string, number> = {
      ArrowLeft: current - step,
      ArrowDown: current - step,
      ArrowRight: current + step,
      ArrowUp: current + step,
      Home: boundary === 'start' ? 0 : selection.start + MIN_RANGE_SECONDS,
      End: boundary === 'start' ? selection.end - MIN_RANGE_SECONDS : duration,
    }
    const next = targets[event.key]
    if (next === undefined) return
    event.preventDefault()
    changeBoundary(boundary, next)
  }

  return (
    <section aria-label="视频编辑时间线" className="video-editor-timeline">
      <header className="video-editor-timeline-toolbar">
        <div className="video-editor-timeline-heading">
          <h3>时间线</h3>
          <EditorVersionMenu
            entries={entries}
            label={label}
            onSelect={onSelect}
            posterOf={posterOf}
            selectedKey={selectedKey}
          />
        </div>
        <div aria-label="时间线操作" className="video-editor-timeline-tools" role="group">
          <IconButton
            disabled={zoomIndex === 0}
            label="缩小时间线"
            name="zoom-out"
            onClick={() => setZoomIndex((current) => Math.max(0, current - 1))}
            size="md"
          />
          <IconButton
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            label="放大时间线"
            name="add"
            onClick={() => setZoomIndex((current) => Math.min(ZOOM_LEVELS.length - 1, current + 1))}
            size="md"
          />
          <IconButton
            label="时间线适应宽度"
            name="maximize-panel"
            onClick={() => {
              setZoomIndex(0)
              contentRef.current?.parentElement?.scrollTo({ left: 0 })
            }}
            size="md"
          />
          <Button onClick={onHistory} size="md" trailingIcon="next" variant="ghost">
            历史
          </Button>
        </div>
      </header>

      <div className="video-editor-timeline-viewport">
        <div aria-hidden="true" className="video-editor-timeline-labels">
          <div className="video-editor-timeline-ruler-spacer" />
          <div className="video-editor-timeline-track-label">
            <Icon decorative name="locked" size="md" />
            <div>
              <strong>{base?.label ?? '原片'}</strong>
              <span>{baseDuration === undefined ? '—' : `${roundSeconds(baseDuration)}s`}</span>
            </div>
          </div>
          <div className="video-editor-timeline-track-label video-editor-timeline-current-label">
            <Icon decorative name="video" size="md" />
            <div>
              <strong>{label}</strong>
              <span>{roundSeconds(duration)}s</span>
            </div>
          </div>
        </div>
        <div
          aria-label="时间线轨道，放大后可横向滚动"
          className="video-editor-timeline-scroll"
          role="region"
        >
          <div
            className="video-editor-timeline-content"
            ref={contentRef}
            style={{ minWidth: `${640 * zoom}px` }}
          >
            <div className="video-editor-timeline-ruler">
              {ticks.map((time) => (
                <span
                  aria-hidden="true"
                  className={cn('video-editor-timeline-tick', time === duration && 'is-last')}
                  key={time}
                  style={{ left: percent(time) }}
                >
                  {roundSeconds(time)}s
                </span>
              ))}
              <input
                aria-label="时间线播放位置"
                aria-valuetext={timeLabel(boundedTime)}
                className="video-editor-timeline-seek"
                max={duration}
                min={0}
                onChange={(event) => onSeek(Number(event.target.value))}
                step={0.01}
                type="range"
                value={boundedTime}
              />
            </div>

            <div
              aria-label="基底对应内容"
              className="video-editor-timeline-track video-editor-timeline-source-track"
            >
              {segments.map((segment) => (
                <div
                  className={cn(
                    'video-editor-timeline-source-segment',
                    segment.role === 'edited' && 'is-gap',
                  )}
                  key={`${segment.mediaUrl}:${segment.at}`}
                  style={{ width: percent(segment.duration) }}
                  title={
                    segment.role === 'edited'
                      ? '这一段换成了编辑结果'
                      : `${base?.label ?? '原片'} ${timeLabel(segment.start)} — ${timeLabel(segment.end)}`
                  }
                >
                  {segment.role === 'edited' ? (
                    <span className="video-editor-timeline-gap">编辑结果</span>
                  ) : (
                    <>
                      <SegmentFrames
                        count={frameCount(segment)}
                        poster={posterOf(segment.mediaUrl)}
                      />
                      <span className="video-editor-timeline-source-time">
                        {roundSeconds(segment.start)}s
                      </span>
                      {segment === lastBase ? (
                        <span className="video-editor-timeline-source-time is-end">
                          {roundSeconds(segment.end)}s
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
            </div>

            <div
              aria-label={`${label} 完整视频`}
              className="video-editor-timeline-track video-editor-timeline-current-track"
            >
              {segments.map((segment) => {
                const range = { start: segment.at, end: segment.at + segment.duration }
                const isSelected =
                  selection !== null &&
                  range.start === selection.start &&
                  range.end === selection.end
                return (
                  <button
                    aria-label={`${segment.role === 'edited' ? '编辑结果' : '原片内容'} ${timeLabel(range.start)} 至 ${timeLabel(range.end)}`}
                    aria-pressed={selection === null ? undefined : isSelected}
                    className={cn(
                      'video-editor-timeline-segment ui-focus',
                      segment.role === 'edited' && 'is-edited',
                    )}
                    key={`${segment.mediaUrl}:${segment.at}`}
                    onClick={() => {
                      if (selection !== null) onSelectionChange(range, 'start')
                      else onSeek(range.start)
                    }}
                    style={{ width: percent(segment.duration) }}
                    type="button"
                  >
                    <SegmentFrames
                      count={frameCount(segment)}
                      poster={posterOf(segment.mediaUrl)}
                    />
                    {segment.role === 'edited' ? (
                      <span className="video-editor-timeline-change-label">编辑结果</span>
                    ) : null}
                  </button>
                )
              })}
              {selection === null ? null : (
                <>
                  <div
                    className="video-editor-timeline-selection"
                    style={{
                      left: percent(selection.start),
                      width: percent(selection.end - selection.start),
                    }}
                  />
                  {(['start', 'end'] as const).map((boundary) => (
                    <button
                      aria-label={boundary === 'start' ? '选段开始时间' : '选段结束时间'}
                      aria-valuemax={
                        boundary === 'start' ? selection.end - MIN_RANGE_SECONDS : duration
                      }
                      aria-valuemin={boundary === 'start' ? 0 : selection.start + MIN_RANGE_SECONDS}
                      aria-valuenow={selection[boundary]}
                      aria-valuetext={timeLabel(selection[boundary])}
                      className={cn('video-editor-timeline-handle ui-focus', `is-${boundary}`)}
                      key={boundary}
                      onKeyDown={(event) => keyBoundary(event, boundary)}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        event.currentTarget.focus()
                        event.currentTarget.setPointerCapture(event.pointerId)
                        onSelectionChange(selection, boundary)
                      }}
                      onPointerMove={(event) => dragBoundary(event, boundary)}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          dragBoundary(event, boundary)
                          event.currentTarget.releasePointerCapture(event.pointerId)
                        }
                      }}
                      role="slider"
                      style={{ left: percent(selection[boundary]) }}
                      title={`${boundary === 'start' ? '开始' : '结束'} ${timeLabel(selection[boundary])}；方向键微调，Shift 加速`}
                      type="button"
                    >
                      <span />
                    </button>
                  ))}
                </>
              )}
            </div>
            <div
              aria-hidden="true"
              className="video-editor-timeline-playhead"
              style={{ left: percent(boundedTime) }}
            >
              <span
                className={cn(
                  boundedTime / duration < 0.08 && 'at-start',
                  boundedTime / duration > 0.92 && 'at-end',
                )}
              >
                {timeLabel(boundedTime)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <footer className="video-editor-timeline-footer">
        <div className="video-editor-timeline-legend">
          <span className="is-edited">编辑结果</span>
        </div>
        <nav aria-label="当前版本来源" className="video-editor-timeline-ancestors">
          {ancestors.map((ancestor, at) => (
            <span className="video-editor-timeline-ancestor" key={ancestor.key}>
              <button
                aria-current={at === ancestors.length - 1 ? 'step' : undefined}
                className="ui-focus"
                onClick={() => onSelect(ancestor.key)}
                type="button"
              >
                {ancestor.label}
              </button>
              {at < ancestors.length - 1 ? <Icon decorative name="next" size="sm" /> : null}
            </span>
          ))}
        </nav>
      </footer>
    </section>
  )
}
