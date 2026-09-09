import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { mintUuid } from '@/shared/lib/uuid'
import { Button, IconButton } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'
import {
  annotationHandles,
  annotationVisual,
  imagePoint,
  isUsableAnnotation,
  moveAnnotation,
  resizeAnnotation,
} from './annotation-geometry'
import type { AnnotationKind, AnnotationPoint, ImageAnnotation } from './image-edit-types'

type AnnotationCanvasProps = {
  url: string
  annotations: ImageAnnotation[]
  onChange: (annotations: ImageAnnotation[]) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  disabled?: boolean
  onInsertReference?: (id: string) => void
}

type Gesture = {
  pointerId: number
  kind: 'draw' | 'move' | 'resize'
  start: AnnotationPoint
  original: ImageAnnotation
  current: ImageAnnotation
  handle: number
}

const TOOLS = [
  { kind: 'point', label: '点标注' },
  { kind: 'rectangle', label: '矩形标注' },
  { kind: 'ellipse', label: '椭圆标注' },
  { kind: 'arrow', label: '箭头标注' },
  { kind: 'pen', label: '自由画笔' },
] as const

export function AnnotationCanvas({
  url,
  annotations,
  onChange,
  selectedId,
  onSelect,
  disabled = false,
  onInsertReference,
}: AnnotationCanvasProps) {
  const [tool, setTool] = useState<AnnotationKind>('point')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [imageFailed, setImageFailed] = useState(false)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [nextNumber, setNextNumber] = useState(
    () => Math.max(0, ...annotations.map((annotation) => annotation.number)) + 1,
  )
  const [history, setHistory] = useState({
    present: annotations,
    past: [] as ImageAnnotation[][],
    future: [] as ImageAnnotation[][],
  })
  // An externally restored draft starts a new history; local commits keep their own stack.
  if (annotations !== history.present) {
    setHistory({ present: annotations, past: [], future: [] })
    setGesture(null)
    setNextNumber(Math.max(nextNumber, ...annotations.map((annotation) => annotation.number + 1)))
  }
  const blocked = disabled || !size.width || imageFailed
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const displayScale =
    size.width && viewport.width && viewport.height
      ? Math.min(viewport.width / size.width, viewport.height / size.height)
      : 1
  const unitsPerPixel = 1 / displayScale

  function commit(next: ImageAnnotation[]) {
    setHistory({ present: next, past: [...history.past, annotations].slice(-100), future: [] })
    onChange(next)
  }

  function undo() {
    const previous = history.past.at(-1)
    if (blocked || !previous || gesture) return
    setHistory({
      present: previous,
      past: history.past.slice(0, -1),
      future: [annotations, ...history.future],
    })
    onChange(previous)
    if (!previous.some((annotation) => annotation.id === selectedId)) onSelect(null)
  }

  function redo() {
    const next = history.future[0]
    if (blocked || !next || gesture) return
    setHistory({
      present: next,
      past: [...history.past, annotations],
      future: history.future.slice(1),
    })
    onChange(next)
  }

  function removeSelected() {
    if (blocked || !selectedId || gesture) return
    commit(annotations.filter((annotation) => annotation.id !== selectedId))
    onSelect(null)
  }

  function clearAnnotations() {
    if (blocked || gesture || annotations.length === 0) return
    commit([])
    onSelect(null)
  }

  function pointerPoint(event: PointerEvent<SVGSVGElement>, constrain = false) {
    return imagePoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      size,
      constrain,
    )
  }

  function startGesture(event: PointerEvent<SVGSVGElement>) {
    if (blocked || gesture || event.button !== 0) return
    const point = pointerPoint(event)
    if (!point) {
      onSelect(null)
      return
    }
    event.preventDefault()
    event.currentTarget.focus()
    const element = event.target instanceof Element ? event.target : null
    const shape = element?.closest('[data-annotation-id]')
    const selected = annotations.find(
      (annotation) => annotation.id === shape?.getAttribute('data-annotation-id'),
    )
    const handleValue = element?.closest('[data-handle]')?.getAttribute('data-handle')
    const handle = handleValue == null ? -1 : Number(handleValue)
    let original: ImageAnnotation
    let kind: Gesture['kind']
    if (selected) {
      original = selected
      kind = handle >= 0 ? 'resize' : 'move'
    } else {
      // 第一次空白点击仅取消当前选择，不能意外新增点或笔迹。
      if (selectedId !== null) {
        onSelect(null)
        return
      }
      if (annotations.length >= 50) {
        toast.error('每张图片最多添加 50 个标注')
        return
      }
      original = {
        id: mintUuid(),
        number: nextNumber,
        kind: tool,
        points: tool === 'point' ? [point] : [point, point],
      }
      kind = 'draw'
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (kind !== 'draw') onSelect(original.id)
    setGesture({
      pointerId: event.pointerId,
      kind,
      start: point,
      original,
      current: original,
      handle,
    })
  }

  function updateGesture(event: PointerEvent<SVGSVGElement>) {
    if (blocked || !gesture || gesture.pointerId !== event.pointerId) return
    const point = pointerPoint(event, true)
    if (!point) return
    setGesture((previous) => {
      if (!previous) return null
      let current: ImageAnnotation
      if (previous.kind === 'move') {
        current = moveAnnotation(previous.original, {
          x: point.x - previous.start.x,
          y: point.y - previous.start.y,
        })
      } else if (previous.kind === 'resize') {
        current = resizeAnnotation(previous.original, previous.handle, point)
      } else if (previous.original.kind === 'point') {
        current = { ...previous.original, points: [point] }
      } else if (previous.original.kind === 'pen') {
        const last = previous.current.points.at(-1)
        if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.001) return previous
        // 长笔迹均匀降采样，保留整段轨迹，不能截断后把终点直接连回第 499 个点。
        const points =
          previous.current.points.length >= 500
            ? previous.current.points.filter((_, index) => index % 2 === 0)
            : previous.current.points
        current = { ...previous.current, points: [...points, point] }
      } else {
        current = { ...previous.original, points: [previous.start, point] }
      }
      return { ...previous, current }
    })
  }

  function finishGesture(event: PointerEvent<SVGSVGElement>) {
    if (!gesture || gesture.pointerId !== event.pointerId) return
    setGesture(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (blocked) return
    if (!isUsableAnnotation(gesture.current)) {
      if (gesture.kind === 'draw') onSelect(null)
      return
    }
    if (gesture.kind === 'draw') {
      commit([...annotations, gesture.current])
      setNextNumber(nextNumber + 1)
      onSelect(null)
    } else if (gesture.current !== gesture.original) {
      commit(
        annotations.map((annotation) =>
          annotation.id === gesture.current.id ? gesture.current : annotation,
        ),
      )
    }
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (blocked) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) redo()
      else undo()
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      event.stopPropagation()
      redo()
    } else if (event.key === 'Escape' && (gesture || selectedId)) {
      event.preventDefault()
      event.stopPropagation()
      setGesture(null)
      onSelect(null)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      removeSelected()
    } else if (
      event.target instanceof SVGElement &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      const selected = annotations.find((annotation) => annotation.id === selectedId)
      if (!selected) return
      event.preventDefault()
      event.stopPropagation()
      const distance = event.shiftKey ? 0.05 : 0.01
      const next = moveAnnotation(selected, {
        x: event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0,
        y: event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0,
      })
      commit(annotations.map((annotation) => (annotation.id === next.id ? next : annotation)))
    }
  }

  const visible =
    gesture?.kind === 'draw'
      ? [...annotations, gesture.current]
      : annotations.map((annotation) =>
          annotation.id === gesture?.current.id ? gesture.current : annotation,
        )

  const selectedAnnotation = visible.find((annotation) => annotation.id === selectedId)
  const selectedGeometry = selectedAnnotation
    ? annotationVisual(selectedAnnotation, size, unitsPerPixel)
    : null
  const imageLeft = (viewport.width - size.width * displayScale) / 2
  const imageTop = (viewport.height - size.height * displayScale) / 2
  const toolbarWidth = Math.min(240, Math.max(0, viewport.width - 16))
  const toolbarLeft = selectedGeometry
    ? Math.max(
        8,
        Math.min(
          viewport.width - toolbarWidth - 8,
          imageLeft + selectedGeometry.label.x * displayScale - toolbarWidth / 2,
        ),
      )
    : 8
  const annotationTop = selectedGeometry
    ? imageTop +
      Math.min(selectedGeometry.top, selectedGeometry.label.y - selectedGeometry.label.height / 2) *
        displayScale
    : 0
  const annotationBottom = selectedGeometry
    ? imageTop +
      Math.max(
        selectedGeometry.top + selectedGeometry.height,
        selectedGeometry.label.y + selectedGeometry.label.height / 2,
      ) *
        displayScale
    : 0
  let toolbarTop =
    annotationTop >= 64
      ? annotationTop - 56
      : Math.max(8, Math.min(viewport.height - 52, annotationBottom + 12))
  // 操作条避开其它编号，密集标注也能直接找到并切换选中对象。
  if (selectedAnnotation) {
    const labels = visible
      .map((annotation) => {
        const { label } = annotationVisual(annotation, size, unitsPerPixel)
        return {
          left: imageLeft + (label.x - label.width / 2) * displayScale,
          right: imageLeft + (label.x + label.width / 2) * displayScale,
          top: imageTop + (label.y - label.height / 2) * displayScale,
          bottom: imageTop + (label.y + label.height / 2) * displayScale,
        }
      })
      .filter(
        (label) => label.right + 8 > toolbarLeft && label.left - 8 < toolbarLeft + toolbarWidth,
      )
    for (const label of labels.toSorted((a, b) => b.top - a.top)) {
      if (toolbarTop < label.bottom + 8 && toolbarTop + 52 > label.top - 8)
        toolbarTop = label.top - 60
    }
    if (toolbarTop < 8) {
      toolbarTop = annotationBottom + 12
      for (const label of labels.toSorted((a, b) => a.top - b.top)) {
        if (toolbarTop < label.bottom + 8 && toolbarTop + 52 > label.top - 8)
          toolbarTop = label.bottom + 8
      }
      toolbarTop = Math.max(8, Math.min(viewport.height - 52, toolbarTop))
    }
  }

  return (
    <div className="image-edit-canvas" role="group" aria-label="图片标注编辑器">
      <div className="image-edit-canvas-toolbar" role="toolbar" aria-label="标注工具">
        {TOOLS.map(({ kind, label }) => (
          <IconButton
            key={kind}
            label={label}
            title={label}
            name={kind}
            variant={tool === kind ? 'selected' : 'standard'}
            aria-pressed={tool === kind}
            disabled={Boolean(blocked)}
            onClick={() => {
              setTool(kind)
              onSelect(null)
            }}
          />
        ))}
        <span className="image-edit-canvas-toolbar-divider" aria-hidden="true" />
        <IconButton
          label="撤销标注"
          title="撤销标注"
          name="undo"
          disabled={Boolean(blocked) || history.past.length === 0}
          onClick={undo}
        />
        <IconButton
          label="重做标注"
          title="重做标注"
          name="redo"
          disabled={Boolean(blocked) || history.future.length === 0}
          onClick={redo}
        />
        <IconButton
          label="清空标注"
          title="清空全部标注，可撤销"
          name="delete"
          disabled={Boolean(blocked) || annotations.length === 0 || gesture !== null}
          onClick={clearAnnotations}
        />
      </div>
      <div ref={viewportRef} className="image-edit-canvas-viewport">
        <img
          src={url}
          alt="当前编辑帧"
          className="image-edit-canvas-source"
          draggable={false}
          onLoad={(event) => {
            setImageFailed(false)
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }}
          onError={() => setImageFailed(true)}
        />
        {imageFailed && (
          <p role="alert" className="text-body-sm text-error">
            原图加载失败，请关闭后重试
          </p>
        )}
        {size.width > 0 && !imageFailed && (
          <svg
            onKeyDown={handleKeyDown}
            data-annotation-canvas=""
            className="image-edit-canvas-surface ui-focus ui-focus-inline"
            viewBox={`0 0 ${size.width} ${size.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label="图片标注画布"
            tabIndex={0}
            style={{
              touchAction: 'none',
              cursor: blocked ? 'default' : 'crosshair',
            }}
            onPointerDown={startGesture}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
            onPointerCancel={() => {
              setGesture(null)
              if (gesture?.kind === 'draw') onSelect(null)
            }}
            onLostPointerCapture={() => {
              setGesture(null)
            }}
          >
            {visible.map((annotation) => (
              <AnnotationMark
                key={annotation.id}
                annotation={annotation}
                size={size}
                unitsPerPixel={unitsPerPixel}
                draft={gesture?.kind === 'draw' && gesture.current.id === annotation.id}
                selected={annotation.id === selectedId}
                disabled={Boolean(blocked)}
                onSelect={() => onSelect(annotation.id)}
              />
            ))}
          </svg>
        )}
        {selectedAnnotation && !blocked && !gesture && (
          <div
            className="image-edit-annotation-actions"
            role="toolbar"
            aria-label={`标注 ${selectedAnnotation.number} 操作`}
            style={{ left: toolbarLeft, top: toolbarTop, width: toolbarWidth }}
          >
            <span className="min-w-0 flex-1 truncate text-body text-on-surface">
              标注 {selectedAnnotation.number} · {TOOL_NAMES[selectedAnnotation.kind]}
            </span>
            {onInsertReference && (
              <Button
                variant="ghost"
                size="md"
                aria-label="引用选中标注"
                onClick={() => onInsertReference(selectedAnnotation.id)}
              >
                引用
              </Button>
            )}
            <IconButton label="删除此标注" name="delete" onClick={removeSelected} />
          </div>
        )}
      </div>
    </div>
  )
}

const TOOL_NAMES: Record<AnnotationKind, string> = {
  point: '点',
  rectangle: '矩形',
  ellipse: '椭圆',
  arrow: '箭头',
  pen: '画笔',
}

function AnnotationMark({
  annotation,
  size,
  unitsPerPixel,
  draft,
  selected,
  disabled,
  onSelect,
}: {
  annotation: ImageAnnotation
  size: { width: number; height: number }
  unitsPerPixel: number
  draft: boolean
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const geometry = annotationVisual(annotation, size, unitsPerPixel)
  const points = geometry.points.map((p) => `${p.x},${p.y}`).join(' ')
  const shape =
    annotation.kind === 'rectangle' ? (
      <rect x={geometry.left} y={geometry.top} width={geometry.width} height={geometry.height} />
    ) : annotation.kind === 'ellipse' ? (
      <ellipse
        cx={geometry.left + geometry.width / 2}
        cy={geometry.top + geometry.height / 2}
        rx={geometry.width / 2}
        ry={geometry.height / 2}
      />
    ) : annotation.kind === 'pen' ? (
      <path d={geometry.penPath} />
    ) : annotation.kind === 'arrow' ? (
      <>
        <polyline points={points} />
        <polyline points={geometry.arrow.map((p) => `${p.x},${p.y}`).join(' ')} />
      </>
    ) : (
      <circle cx={geometry.anchor.x} cy={geometry.anchor.y} r={geometry.targetRadius} />
    )
  const connector = `${geometry.connector.start.x},${geometry.connector.start.y} ${geometry.connector.end.x},${geometry.connector.end.y}`
  const unit = unitsPerPixel
  return (
    <g
      data-annotation-id={draft ? undefined : annotation.id}
      data-annotation-kind={annotation.kind}
      role={draft ? undefined : 'button'}
      tabIndex={disabled || draft ? -1 : 0}
      aria-label={draft ? undefined : `标注 ${annotation.number}`}
      aria-pressed={draft ? undefined : selected}
      aria-disabled={disabled}
      onKeyDown={(event) => {
        if (!disabled && !draft && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      className="image-edit-annotation"
      style={{
        color: 'var(--color-error)',
        cursor: draft ? 'crosshair' : selected ? 'move' : 'pointer',
      }}
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {selected && (
          <g
            stroke="currentColor"
            strokeWidth={geometry.strokeWidth + 6 * unit}
            opacity={0.2}
            pointerEvents="none"
          >
            {shape}
          </g>
        )}
        <g
          stroke="var(--color-on-scrim)"
          strokeWidth={geometry.strokeWidth + geometry.haloWidth}
          pointerEvents="none"
        >
          {shape}
        </g>
        <g stroke="currentColor" strokeWidth={geometry.strokeWidth} data-annotation-outline="">
          {shape}
        </g>
        <g
          stroke="transparent"
          strokeWidth={Math.max(12 * unit, geometry.strokeWidth)}
          fill={annotation.kind === 'point' ? 'transparent' : 'none'}
          pointerEvents={annotation.kind === 'point' ? 'all' : 'stroke'}
          aria-hidden="true"
        >
          {shape}
        </g>
      </g>
      {annotation.kind === 'point' && (
        <circle
          cx={geometry.anchor.x}
          cy={geometry.anchor.y}
          r={geometry.targetDotRadius}
          paintOrder="stroke fill"
          fill="currentColor"
          stroke="var(--color-on-scrim)"
          strokeWidth={2 * unit}
          pointerEvents="none"
        />
      )}
      {!draft && (
        <g data-annotation-label="">
          <polyline
            points={connector}
            fill="none"
            stroke="var(--color-on-scrim)"
            strokeWidth={5 * unit}
            pointerEvents="none"
          />
          <polyline
            points={connector}
            fill="none"
            stroke="var(--color-scrim)"
            strokeWidth={2 * unit}
            pointerEvents="none"
          />
          <rect
            x={geometry.label.x - geometry.label.width / 2}
            y={geometry.label.y - geometry.label.height / 2}
            width={geometry.label.width}
            height={geometry.label.height}
            rx={geometry.label.radius}
            fill="var(--color-scrim)"
            stroke="var(--color-on-scrim)"
            strokeWidth={1.5 * unit}
          />
          <text
            x={geometry.label.x}
            y={geometry.label.y}
            fill="var(--color-on-scrim)"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={geometry.label.fontSize}
            fontWeight={600}
            pointerEvents="none"
          >
            {annotation.number}
          </text>
        </g>
      )}
      {selected &&
        !disabled &&
        annotationHandles(annotation).map((point, index) => {
          const x = point.x * size.width
          const y = point.y * size.height
          const handleSize = 8 * unit
          const cursor =
            annotation.kind === 'arrow'
              ? 'move'
              : annotation.kind === 'ellipse'
                ? index % 2 === 0
                  ? 'ns-resize'
                  : 'ew-resize'
                : index % 2 === 0
                  ? 'nwse-resize'
                  : 'nesw-resize'
          return (
            <g
              key={['top', 'right', 'bottom', 'left'][index]}
              data-handle={index}
              style={{ cursor }}
            >
              <rect
                x={x - 10 * unit}
                y={y - 10 * unit}
                width={20 * unit}
                height={20 * unit}
                fill="transparent"
              />
              {annotation.kind === 'rectangle' ? (
                <rect
                  x={x - handleSize / 2}
                  y={y - handleSize / 2}
                  width={handleSize}
                  height={handleSize}
                  rx={unit}
                  fill="var(--color-on-scrim)"
                  stroke="currentColor"
                  strokeWidth={1.5 * unit}
                />
              ) : (
                <circle
                  cx={x}
                  cy={y}
                  r={handleSize / 2}
                  fill="var(--color-on-scrim)"
                  stroke="currentColor"
                  strokeWidth={1.5 * unit}
                />
              )}
            </g>
          )
        })}
    </g>
  )
}
