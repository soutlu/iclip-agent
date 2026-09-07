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

export function isUsableAnnotation(annotation: ImageAnnotation): boolean {
  if (annotation.kind === 'point') return annotation.points.length === 1
  if (annotation.points.length < 2) return false
  const bounds = annotationBounds(annotation)
  if (annotation.kind === 'rectangle' || annotation.kind === 'ellipse') {
    return bounds.right - bounds.left > 0.003 && bounds.bottom - bounds.top > 0.003
  }
  return bounds.right - bounds.left > 0.003 || bounds.bottom - bounds.top > 0.003
}
