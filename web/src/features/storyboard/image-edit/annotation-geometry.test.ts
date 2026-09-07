import { describe, expect, it } from 'vitest'
import {
  annotationVisual,
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

  it('resizes a pen stroke proportionally and an arrow by its chosen endpoint', () => {
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
    expect(resized.points[1]?.x).toBeCloseTo(0.6)
    expect(resized.points[1]?.y).toBeCloseTo(0.4)
    expect(resizeAnnotation({ ...rectangle, kind: 'arrow' }, 1, { x: 1.2, y: -1 }).points).toEqual([
      { x: 0.2, y: 0.3 },
      { x: 1, y: 0 },
    ])
  })

  it('shares undistorted pixel geometry and readable numbered labels with export', () => {
    const visual = annotationVisual(rectangle, { width: 1000, height: 2000 })
    expect(visual.left).toBe(200)
    expect(visual.top).toBe(600)
    expect(visual.width).toBeCloseTo(400)
    expect(visual.height).toBe(1000)
    expect(visual.label.x).toBe(224)
    expect(visual.label.y).toBeCloseTo(566.4)
    const edge = annotationVisual(
      {
        ...rectangle,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
      { width: 1000, height: 2000 },
    )
    expect(edge.label.y).toBe(edge.radius)
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
