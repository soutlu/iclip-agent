import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { IconButton } from '@/shared/ui/button'
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
  { kind: 'select', label: '选择标注' },
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
  const [tool, setTool] = useState<'select' | AnnotationKind>('select')
  const [size, setSize] = useState({ width: 0, height: 0 })
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
    if (!point) return
    event.preventDefault()
    event.currentTarget.focus()
    const element = event.target instanceof Element ? event.target : null
    const shape = element?.closest('[data-annotation-id]')
    const selected = annotations.find(
      (annotation) => annotation.id === shape?.getAttribute('data-annotation-id'),
    )
    const handleValue = element?.getAttribute('data-handle')
    const handle = handleValue == null ? -1 : Number(handleValue)
    let original: ImageAnnotation
    let kind: Gesture['kind']
    if (selected && (tool === 'select' || handle >= 0)) {
      original = selected
      kind = handle >= 0 ? 'resize' : 'move'
    } else if (tool !== 'select') {
      if (annotations.length >= 50) {
        toast.error('每张图片最多添加 50 个标注')
        return
      }
      original = {
        id: crypto.randomUUID(),
        number: nextNumber,
        kind: tool,
        points: [point, point],
      }
      kind = 'draw'
      setNextNumber(nextNumber + 1)
    } else {
      onSelect(null)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelect(original.id)
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
      } else if (previous.original.kind === 'pen') {
        const last = previous.current.points.at(-1)
        if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.001) return previous
        current = { ...previous.current, points: [...previous.current.points.slice(0, 499), point] }
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
      setTool('select')
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
    } else if (event.key === 'Escape' && gesture) {
      event.preventDefault()
      event.stopPropagation()
      setGesture(null)
      if (gesture.kind === 'draw') onSelect(null)
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
            onClick={() => setTool(kind)}
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
          label="删除标注"
          title="删除标注"
          name="delete"
          disabled={Boolean(blocked) || !selectedId}
          onClick={removeSelected}
        />
        {onInsertReference && (
          <IconButton
            label="引用选中标注"
            title="引用选中标注"
            name="reference"
            disabled={Boolean(blocked) || !selectedId}
            onClick={() => {
              if (selectedId) onInsertReference(selectedId)
            }}
          />
        )}
      </div>
      <div className="image-edit-canvas-viewport">
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
            className="image-edit-canvas-surface"
            viewBox={`0 0 ${size.width} ${size.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label="图片标注画布"
            tabIndex={0}
            style={{
              touchAction: 'none',
              cursor: blocked ? 'default' : tool === 'select' ? 'default' : 'crosshair',
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
                selected={annotation.id === selectedId}
                disabled={Boolean(blocked)}
                onSelect={() => onSelect(annotation.id)}
              />
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}

function AnnotationMark({
  annotation,
  size,
  selected,
  disabled,
  onSelect,
}: {
  annotation: ImageAnnotation
  size: { width: number; height: number }
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const geometry = annotationVisual(annotation, size)
  const points = geometry.points.map((p) => `${p.x},${p.y}`).join(' ')
  return (
    <g
      data-annotation-id={annotation.id}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={`标注 ${annotation.number}`}
      aria-pressed={selected}
      aria-disabled={disabled}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      style={{ color: 'var(--color-error)' }}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={geometry.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {annotation.kind === 'rectangle' ? (
          <rect
            x={geometry.left}
            y={geometry.top}
            width={geometry.width}
            height={geometry.height}
            fill="transparent"
          />
        ) : annotation.kind === 'ellipse' ? (
          <ellipse
            cx={geometry.left + geometry.width / 2}
            cy={geometry.top + geometry.height / 2}
            rx={geometry.width / 2}
            ry={geometry.height / 2}
            fill="transparent"
          />
        ) : (
          <polyline points={points} />
        )}
        {(annotation.kind === 'pen' || annotation.kind === 'arrow') && (
          <polyline
            points={points}
            stroke="transparent"
            strokeWidth={geometry.strokeWidth * 6}
            pointerEvents="stroke"
          />
        )}
        {annotation.kind === 'arrow' && (
          <polyline points={geometry.arrow.map((p) => `${p.x},${p.y}`).join(' ')} />
        )}
      </g>
      <circle
        cx={geometry.label.x}
        cy={geometry.label.y}
        r={geometry.radius}
        fill="currentColor"
        stroke="var(--color-on-error)"
        strokeWidth={geometry.strokeWidth * 0.7}
      />
      <text
        x={geometry.label.x}
        y={geometry.label.y}
        fill="var(--color-on-error)"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={geometry.radius * 1.25}
        fontWeight={600}
        pointerEvents="none"
      >
        {annotation.number}
      </text>
      {selected &&
        !disabled &&
        annotationHandles(annotation).map((point, index) => (
          <circle
            key={['top-left', 'top-right', 'bottom-right', 'bottom-left'][index]}
            data-handle={index}
            cx={point.x * size.width}
            cy={point.y * size.height}
            r={geometry.radius * 0.4}
            fill="var(--color-on-error)"
            stroke="currentColor"
            strokeWidth={geometry.strokeWidth}
            style={{
              cursor:
                annotation.kind === 'arrow'
                  ? 'move'
                  : index % 2 === 0
                    ? 'nwse-resize'
                    : 'nesw-resize',
            }}
          />
        ))}
    </g>
  )
}
