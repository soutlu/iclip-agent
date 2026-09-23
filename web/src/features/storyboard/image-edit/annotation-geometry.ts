import type { AnnotationPoint, ImageAnnotation } from './image-edit-types'

type ImageSize = { width: number; height: number }
type Bounds = { left: number; top: number; right: number; bottom: number }

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

/** Convert viewport coordinates to the contained image, excluding its letterbox. */
export function imagePoint(
  client: AnnotationPoint,
  viewport: { left: number; top: number; width: number; height: number },
  image: ImageSize,
  constrain = false,
): AnnotationPoint | null {
  if (!viewport.width || !viewport.height || !image.width || !image.height) return null
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  const x = (client.x - viewport.left - (viewport.width - width) / 2) / width
  const y = (client.y - viewport.top - (viewport.height - height) / 2) / height
  if (!constrain && (x < 0 || x > 1 || y < 0 || y > 1)) return null
  return { x: clamp(x), y: clamp(y) }
}

export function annotationBounds(annotation: ImageAnnotation): Bounds {
  return {
    left: Math.min(...annotation.points.map((p) => p.x)),
    top: Math.min(...annotation.points.map((p) => p.y)),
    right: Math.max(...annotation.points.map((p) => p.x)),
    bottom: Math.max(...annotation.points.map((p) => p.y)),
  }
}

/** Clamp the entire shape, preserving its size when dragging against an image edge. */
export function moveAnnotation(
  annotation: ImageAnnotation,
  delta: AnnotationPoint,
): ImageAnnotation {
  const bounds = annotationBounds(annotation)
  const dx = clamp(delta.x, -bounds.left, 1 - bounds.right)
  const dy = clamp(delta.y, -bounds.top, 1 - bounds.bottom)
  return { ...annotation, points: annotation.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
}

/** Each handle edits the visible shape boundary; pen and point marks only move. */
export function resizeAnnotation(
  annotation: ImageAnnotation,
  handle: number,
  point: AnnotationPoint,
): ImageAnnotation {
  if (annotation.kind === 'pen' || annotation.kind === 'point') return annotation
  const target = { x: clamp(point.x), y: clamp(point.y) }
  if (annotation.kind === 'arrow') {
    return { ...annotation, points: annotation.points.map((p, i) => (i === handle ? target : p)) }
  }
  const bounds = annotationBounds(annotation)
  if (annotation.kind === 'ellipse') {
    const next = { ...bounds }
    if (handle === 0) next.top = target.y
    else if (handle === 1) next.right = target.x
    else if (handle === 2) next.bottom = target.y
    else if (handle === 3) next.left = target.x
    return {
      ...annotation,
      points: [
        { x: next.left, y: next.top },
        { x: next.right, y: next.bottom },
      ],
    }
  }
  const anchor = {
    x: handle === 0 || handle === 3 ? bounds.right : bounds.left,
    y: handle === 0 || handle === 1 ? bounds.bottom : bounds.top,
  }
  const moving = {
    x: handle === 0 || handle === 3 ? bounds.left : bounds.right,
    y: handle === 0 || handle === 1 ? bounds.top : bounds.bottom,
  }
  const dx = moving.x - anchor.x
  const dy = moving.y - anchor.y
  return {
    ...annotation,
    points: annotation.points.map((p) => ({
      x: clamp(dx === 0 ? target.x : anchor.x + ((p.x - anchor.x) / dx) * (target.x - anchor.x)),
      y: clamp(dy === 0 ? target.y : anchor.y + ((p.y - anchor.y) / dy) * (target.y - anchor.y)),
    })),
  }
}

export function annotationHandles(annotation: ImageAnnotation): AnnotationPoint[] {
  if (annotation.kind === 'pen' || annotation.kind === 'point') return []
  if (annotation.kind === 'arrow') return annotation.points
  const b = annotationBounds(annotation)
  if (annotation.kind === 'ellipse') {
    return [
      { x: (b.left + b.right) / 2, y: b.top },
      { x: b.right, y: (b.top + b.bottom) / 2 },
      { x: (b.left + b.right) / 2, y: b.bottom },
      { x: b.left, y: (b.top + b.bottom) / 2 },
    ]
  }
  return [
    { x: b.left, y: b.top },
    { x: b.right, y: b.top },
    { x: b.right, y: b.bottom },
    { x: b.left, y: b.bottom },
  ]
}

/** Midpoint quadratic curves retain the first and last sampled points without overshooting. */
function penPath(points: AnnotationPoint[]): string {
  const first = points[0]
  if (!first) return ''
  const commands = [`M ${first.x} ${first.y}`]
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    if (!current || !next) continue
    commands.push(
      `Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`,
    )
  }
  const last = points.at(-1) ?? first
  if (points.length > 1) commands.push(`L ${last.x} ${last.y}`)
  return commands.join(' ')
}

/** Shared image-space geometry; unitsPerPixel keeps controls readable as the viewport resizes. */
export function annotationVisual(annotation: ImageAnnotation, size: ImageSize, unitsPerPixel = 1) {
  const points = annotation.points.map((p) => ({ x: p.x * size.width, y: p.y * size.height }))
  const bounds = annotationBounds(annotation)
  const strokeWidth = 2.5 * unitsPerPixel
  const haloWidth = 3 * unitsPerPixel
  const targetRadius = 9.25 * unitsPerPixel
  const targetDotRadius = 3 * unitsPerPixel
  const first = points[0] ?? { x: 0, y: 0 }
  const last = points.at(-1) ?? first
  const angle = Math.atan2(last.y - first.y, last.x - first.x)
  const arrowLength = 13 * unitsPerPixel
  const arrow = [
    {
      x: last.x - arrowLength * Math.cos(angle - Math.PI / 6),
      y: last.y - arrowLength * Math.sin(angle - Math.PI / 6),
    },
    last,
    {
      x: last.x - arrowLength * Math.cos(angle + Math.PI / 6),
      y: last.y - arrowLength * Math.sin(angle + Math.PI / 6),
    },
  ]
  const left = bounds.left * size.width
  const top = bounds.top * size.height
  const width = (bounds.right - bounds.left) * size.width
  const height = (bounds.bottom - bounds.top) * size.height
  const anchor =
    annotation.kind === 'rectangle'
      ? { x: left, y: top }
      : annotation.kind === 'ellipse'
        ? { x: left + width / 2, y: top }
        : first
  const labelWidth = Math.max(20, String(annotation.number).length * 8 + 8) * unitsPerPixel
  const labelHeight = 20 * unitsPerPixel
  const anchorRadius =
    (annotation.kind === 'point' ? targetRadius : 0) + (strokeWidth + haloWidth) / 2
  // Include the label outline so the visible edges have a full six-pixel gap.
  const gap = (6 + 0.75) * unitsPerPixel
  const dx = anchorRadius + gap + labelWidth / 2
  const dy = anchorRadius + gap + labelHeight / 2
  const candidates = [
    { x: anchor.x, y: anchor.y - dy },
    { x: anchor.x + dx, y: anchor.y },
    { x: anchor.x, y: anchor.y + dy },
    { x: anchor.x - dx, y: anchor.y },
  ]
  const margin = haloWidth / 2
  const overflow = (point: AnnotationPoint) =>
    Math.max(0, labelWidth / 2 + margin - point.x) +
    Math.max(0, point.x + labelWidth / 2 + margin - size.width) +
    Math.max(0, labelHeight / 2 + margin - point.y) +
    Math.max(0, point.y + labelHeight / 2 + margin - size.height)
  const preferred = candidates.reduce((best, point) =>
    overflow(point) < overflow(best) ? point : best,
  )
  const label = {
    x: clamp(preferred.x, labelWidth / 2 + margin, size.width - labelWidth / 2 - margin),
    y: clamp(preferred.y, labelHeight / 2 + margin, size.height - labelHeight / 2 - margin),
    width: labelWidth,
    height: labelHeight,
    fontSize: 14 * unitsPerPixel,
    radius: 4 * unitsPerPixel,
  }
  // Intersect the anchor-to-label ray with both visible boundaries, including after edge clamping.
  const vx = label.x - anchor.x
  const vy = label.y - anchor.y
  const distance = Math.hypot(vx, vy)
  const labelIntersection = Math.min(labelWidth / 2 / Math.abs(vx), labelHeight / 2 / Math.abs(vy))
  const connector = {
    start: {
      x: anchor.x + (distance ? (vx / distance) * anchorRadius : 0),
      y: anchor.y + (distance ? (vy / distance) * anchorRadius : 0),
    },
    end: {
      x: label.x - vx * labelIntersection,
      y: label.y - vy * labelIntersection,
    },
  }
  return {
    points,
    arrow,
    left,
    top,
    width,
    height,
    strokeWidth,
    haloWidth,
    targetRadius,
    targetDotRadius,
    anchor,
    connector,
    label,
    penPath: annotation.kind === 'pen' ? penPath(points) : '',
  }
}

/** 选中标注操作条的尺寸（px），高度对应 CSS 的 --control-height-xl。 */
const TOOLBAR_MAX_WIDTH = 240
const TOOLBAR_HEIGHT = 44
/** 与视口四边、与其它编号之间的留白。 */
const TOOLBAR_INSET = 8
/** 与选中标注之间的间距。 */
const TOOLBAR_GAP = 12
/** 避让时的占位：操作条加下方留白。 */
const TOOLBAR_FOOTPRINT = TOOLBAR_HEIGHT + TOOLBAR_INSET

/** 编号框，以中心点和尺寸表示（annotationVisual 的 label）。 */
type LabelBox = { x: number; y: number; width: number; height: number }

/**
 * 选中标注操作条在视口里的位置（px）。优先放在标注与编号上方，放不下翻到下方；挡住其它编号
 * 就让开，密集标注时也能点到它们；最后夹在视口内。
 * `image` 是底图固有尺寸与显示缩放，底图按 contain 居中；`selected` 与 `labels` 用图片像素坐标，
 * `labels` 含选中标注自己的编号。
 */
export function placeAnnotationToolbar({
  viewport,
  image,
  selected,
  labels,
}: {
  viewport: ImageSize
  image: ImageSize & { scale: number }
  selected: { top: number; height: number; label: LabelBox }
  labels: LabelBox[]
}): { left: number; top: number; width: number } {
  const offsetX = (viewport.width - image.width * image.scale) / 2
  const offsetY = (viewport.height - image.height * image.scale) / 2
  const width = Math.min(TOOLBAR_MAX_WIDTH, Math.max(0, viewport.width - 2 * TOOLBAR_INSET))
  const left = Math.max(
    TOOLBAR_INSET,
    Math.min(
      viewport.width - width - TOOLBAR_INSET,
      offsetX + selected.label.x * image.scale - width / 2,
    ),
  )
  const { label } = selected
  const markTop = offsetY + Math.min(selected.top, label.y - label.height / 2) * image.scale
  const markBottom =
    offsetY + Math.max(selected.top + selected.height, label.y + label.height / 2) * image.scale
  const clampTop = (top: number) =>
    Math.max(TOOLBAR_INSET, Math.min(viewport.height - TOOLBAR_FOOTPRINT, top))
  const obstacles: Bounds[] = labels
    .map((box) => ({
      left: offsetX + (box.x - box.width / 2) * image.scale,
      right: offsetX + (box.x + box.width / 2) * image.scale,
      top: offsetY + (box.y - box.height / 2) * image.scale,
      bottom: offsetY + (box.y + box.height / 2) * image.scale,
    }))
    .filter((box) => box.right + TOOLBAR_INSET > left && box.left - TOOLBAR_INSET < left + width)
  const blocks = (top: number, box: Bounds) =>
    top < box.bottom + TOOLBAR_INSET && top + TOOLBAR_FOOTPRINT > box.top - TOOLBAR_INSET

  let top =
    markTop >= TOOLBAR_HEIGHT + TOOLBAR_GAP + TOOLBAR_INSET
      ? markTop - TOOLBAR_HEIGHT - TOOLBAR_GAP
      : clampTop(markBottom + TOOLBAR_GAP)
  // 自下而上逐个让到编号上方；顶出视口就改到标注下方，自上而下让到编号下方。
  for (const box of obstacles.toSorted((a, b) => b.top - a.top)) {
    if (blocks(top, box)) top = box.top - TOOLBAR_INSET - TOOLBAR_FOOTPRINT
  }
  if (top < TOOLBAR_INSET) {
    top = markBottom + TOOLBAR_GAP
    for (const box of obstacles.toSorted((a, b) => a.top - b.top)) {
      if (blocks(top, box)) top = box.bottom + TOOLBAR_INSET
    }
    top = clampTop(top)
  }
  return { left, top, width }
}

export function isUsableAnnotation(annotation: ImageAnnotation): boolean {
  if (annotation.kind === 'point') return annotation.points.length === 1
  if (annotation.points.length < 2) return false
  const bounds = annotationBounds(annotation)
  if (annotation.kind === 'rectangle' || annotation.kind === 'ellipse') {
    return bounds.right - bounds.left > 0.003 && bounds.bottom - bounds.top > 0.003
  }
  return bounds.right - bounds.left > 0.003 || bounds.bottom - bounds.top > 0.003
}
