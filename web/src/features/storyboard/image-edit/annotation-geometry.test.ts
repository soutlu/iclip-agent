import { describe, expect, it } from 'vitest'
import {
  annotationVisual,
  annotationHandles,
  imagePoint,
  isUsableAnnotation,
  moveAnnotation,
  resizeAnnotation,
} from './annotation-geometry'
import type { ImageAnnotation } from './image-edit-types'

const rectangle: ImageAnnotation = {
  id: 'jacket',
  number: 3,
  kind: 'rectangle',
  points: [
    { x: 0.2, y: 0.3 },
    { x: 0.6, y: 0.8 },
  ],
}

describe('annotation image coordinates', () => {
  it('excludes portrait image letterboxing and clamps a drag leaving the image', () => {
    const viewport = { left: 100, top: 50, width: 800, height: 600 }
    const image = { width: 400, height: 800 }
    expect(imagePoint({ x: 500, y: 350 }, viewport, image)).toEqual({ x: 0.5, y: 0.5 })
    expect(imagePoint({ x: 120, y: 350 }, viewport, image)).toBeNull()
    expect(imagePoint({ x: 120, y: 900 }, viewport, image, true)).toEqual({ x: 0, y: 1 })
  })

  it('maps the same point when a landscape viewport changes size', () => {
    const image = { width: 1600, height: 800 }
    expect(
      imagePoint({ x: 200, y: 300 }, { left: 0, top: 0, width: 800, height: 800 }, image),
    ).toEqual({ x: 0.25, y: 0.25 })
    expect(
      imagePoint({ x: 100, y: 150 }, { left: 0, top: 0, width: 400, height: 400 }, image),
    ).toEqual({ x: 0.25, y: 0.25 })
  })

  it('moves a shape against the border without shrinking it or mutating the original', () => {
    const moved = moveAnnotation(rectangle, { x: 1, y: -1 })
    expect(moved.id).toBe('jacket')
    expect(moved.points[0]?.x).toBeCloseTo(0.6)
    expect(moved.points[1]?.x).toBe(1)
    expect(moved.points[0]?.y).toBe(0)
    expect(moved.points[1]?.y).toBe(0.5)
    expect(rectangle.points[0]).toEqual({ x: 0.2, y: 0.3 })
  })

  it('resizes from an opposite anchor, even when the handle crosses it', () => {
    const resized = resizeAnnotation(rectangle, 0, { x: 0.9, y: 1 })
    expect(resized.points).toEqual([
      { x: 0.9, y: 1 },
      { x: 0.6, y: 0.8 },
    ])
    expect(resized.number).toBe(3)
  })

  it('does not resize pen strokes and edits an arrow by its chosen endpoint', () => {
    const pen: ImageAnnotation = {
      ...rectangle,
      kind: 'pen',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.4, y: 0.3 },
        { x: 0.6, y: 0.6 },
      ],
    }
    const resized = resizeAnnotation(pen, 2, { x: 1, y: 1 })
    expect(resized).toBe(pen)
    expect(annotationHandles(pen)).toEqual([])
    expect(resizeAnnotation({ ...rectangle, kind: 'arrow' }, 1, { x: 1.2, y: -1 }).points).toEqual([
      { x: 0.2, y: 0.3 },
      { x: 1, y: 0 },
    ])
  })

  it('shares undistorted image geometry while keeping markers at their screen size', () => {
    const visual = annotationVisual(rectangle, { width: 1000, height: 2000 }, 2)
    expect(visual.left).toBe(200)
    expect(visual.top).toBe(600)
    expect(visual.width).toBeCloseTo(400)
    expect(visual.height).toBe(1000)
    expect(visual.label.width / 2).toBe(20)
    expect(visual.label.height / 2).toBe(20)
    expect(visual.label.fontSize / 2).toBe(14)
    expect((2 * visual.targetRadius + visual.strokeWidth + visual.haloWidth) / 2).toBe(24)
    expect(visual.anchor).toEqual({ x: 200, y: 600 })
  })

  it('places a point label six screen pixels from its target and preserves the precise landing point', () => {
    const point: ImageAnnotation = { ...rectangle, kind: 'point', points: [{ x: 0.5, y: 0.5 }] }
    const visual = annotationVisual(point, { width: 1000, height: 800 }, 2)
    expect(visual.anchor).toEqual({ x: 500, y: 400 })
    expect(visual.connector.start).toEqual({ x: 500, y: 376 })
    expect(visual.connector.end).toEqual({ x: 500, y: 362.5 })
    expect(isUsableAnnotation(point)).toBe(true)
    expect(annotationHandles(point)).toEqual([])
    expect(resizeAnnotation(point, 0, { x: 1, y: 1 })).toBe(point)
  })

  it.each([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ])('keeps the label on image at corner $x,$y and connects it to the actual target', (point) => {
    const visual = annotationVisual(
      { ...rectangle, kind: 'point', points: [point] },
      { width: 600, height: 800 },
    )
    expect(visual.label.x - visual.label.width / 2).toBeGreaterThanOrEqual(0)
    expect(visual.label.y - visual.label.height / 2).toBeGreaterThanOrEqual(0)
    expect(visual.label.x + visual.label.width / 2).toBeLessThanOrEqual(600)
    expect(visual.label.y + visual.label.height / 2).toBeLessThanOrEqual(800)
    expect(
      Math.hypot(
        visual.connector.start.x - visual.anchor.x,
        visual.connector.start.y - visual.anchor.y,
      ),
    ).toBeCloseTo(visual.targetRadius + (visual.strokeWidth + visual.haloWidth) / 2)
    const startVector = {
      x: visual.connector.start.x - visual.anchor.x,
      y: visual.connector.start.y - visual.anchor.y,
    }
    const endVector = {
      x: visual.connector.end.x - visual.anchor.x,
      y: visual.connector.end.y - visual.anchor.y,
    }
    expect(startVector.x * endVector.y - startVector.y * endVector.x).toBeCloseTo(0)
  })

  it('anchors pen labels to their stroke start, even when another sample extends left', () => {
    const visual = annotationVisual(
      {
        ...rectangle,
        kind: 'pen',
        points: [
          { x: 0.8, y: 0.6 },
          { x: 0.2, y: 0.1 },
          { x: 0.5, y: 0.4 },
        ],
      },
      { width: 1000, height: 1000 },
    )
    expect(visual.anchor).toEqual({ x: 800, y: 600 })
    expect(visual.penPath).toBe('M 800 600 Q 200 100 350 250 L 500 400')
    const arrow = annotationVisual({ ...rectangle, kind: 'arrow' }, { width: 1000, height: 1000 })
    expect(arrow.anchor).toEqual({ x: 200, y: 300 })
  })

  it('puts ellipse handles on its outline and changes only the chosen axis', () => {
    const ellipse = { ...rectangle, kind: 'ellipse' as const }
    expect(annotationHandles(ellipse)).toEqual([
      { x: 0.4, y: 0.3 },
      { x: 0.6, y: 0.55 },
      { x: 0.4, y: 0.8 },
      { x: 0.2, y: 0.55 },
    ])
    expect(resizeAnnotation(ellipse, 1, { x: 0.9, y: 0 }).points).toEqual([
      { x: 0.2, y: 0.3 },
      { x: 0.9, y: 0.8 },
    ])
    expect(annotationVisual(ellipse, { width: 1000, height: 1000 }).anchor).toEqual({
      x: 400,
      y: 300,
    })
  })

  it.each(['rectangle', 'ellipse', 'arrow', 'pen'] as const)(
    'ignores click-only %s marks',
    (kind) => {
      expect(
        isUsableAnnotation({
          ...rectangle,
          kind,
          points: [
            { x: 0.4, y: 0.4 },
            { x: 0.4, y: 0.4 },
          ],
        }),
      ).toBe(false)
    },
  )
})
