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

/** Arrow handles edit endpoints; other shapes scale from the opposite bounding corner. */
export function resizeAnnotation(
  annotation: ImageAnnotation,
  handle: number,
  point: AnnotationPoint,
): ImageAnnotation {
  const target = { x: clamp(point.x), y: clamp(point.y) }
  if (annotation.kind === 'arrow') {
    return { ...annotation, points: annotation.points.map((p, i) => (i === handle ? target : p)) }
  }
  const bounds = annotationBounds(annotation)
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
  if (annotation.kind === 'arrow') return annotation.points
  const b = annotationBounds(annotation)
  return [
    { x: b.left, y: b.top },
    { x: b.right, y: b.top },
    { x: b.right, y: b.bottom },
    { x: b.left, y: b.bottom },
  ]
}

/** Pixel geometry is shared by the SVG preview and explicit exported image. */
export function annotationVisual(annotation: ImageAnnotation, size: ImageSize) {
  const points = annotation.points.map((p) => ({ x: p.x * size.width, y: p.y * size.height }))
  const bounds = annotationBounds(annotation)
  const unit = Math.min(size.width, size.height)
  const strokeWidth = unit * 0.004
  const radius = unit * 0.024
  const first = points[0] ?? { x: 0, y: 0 }
  const last = points.at(-1) ?? first
  const angle = Math.atan2(last.y - first.y, last.x - first.x)
  const arrowLength = unit * 0.032
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
  return {
    points,
    arrow,
    left: bounds.left * size.width,
    top: bounds.top * size.height,
    width: (bounds.right - bounds.left) * size.width,
    height: (bounds.bottom - bounds.top) * size.height,
    strokeWidth,
    radius,
    label: {
      x: clamp(bounds.left * size.width + radius, radius, size.width - radius),
      y: clamp(bounds.top * size.height - radius * 1.4, radius, size.height - radius),
    },
  }
}

export function isUsableAnnotation(annotation: ImageAnnotation): boolean {
  if (annotation.points.length < 2) return false
  const bounds = annotationBounds(annotation)
  if (annotation.kind === 'rectangle' || annotation.kind === 'ellipse') {
    return bounds.right - bounds.left > 0.003 && bounds.bottom - bounds.top > 0.003
  }
  return bounds.right - bounds.left > 0.003 || bounds.bottom - bounds.top > 0.003
}
