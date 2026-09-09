import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportAnnotatedImage } from './annotation-export'
import { annotationVisual } from './annotation-geometry'
import type { ImageAnnotation } from './image-edit-types'

let imageFails = false
let imageWidth = 1200
let imageHeight = 2400

beforeEach(() => {
  imageFails = false
  imageWidth = 1200
  imageHeight = 2400
  vi.stubGlobal(
    'Image',
    class {
      crossOrigin = ''
      naturalWidth = imageWidth
      naturalHeight = imageHeight
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_url: string) {
        queueMicrotask(() => {
          if (imageFails) this.onerror?.()
          else this.onload?.()
        })
      }
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('explicit annotation image export', () => {
  it('exports a numbered PNG and bounds image dimensions while preserving the ratio', async () => {
    imageWidth = 8000
    imageHeight = 12000
    const drawing: number[][] = []
    const context = {
      drawImage: (_image: HTMLImageElement, ...coordinates: number[]) => drawing.push(coordinates),
      beginPath: () => undefined,
      rect: (...coordinates: number[]) => drawing.push(coordinates),
      roundRect: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      arc: () => undefined,
      fill: () => undefined,
      fillText: () => undefined,
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['png'], { type: 'image/png' })),
    )
    const file = await exportAnnotatedImage('/frame.png', [
      {
        id: 'a',
        number: 7,
        kind: 'rectangle',
        points: [
          { x: 0.2, y: 0.3 },
          { x: 0.6, y: 0.8 },
        ],
      },
    ])
    expect(file.name).toBe('annotated-frame.png')
    expect(file.type).toBe('image/png')
    expect(drawing[0]).toEqual([0, 0, 4000, 6000])
    expect(drawing[1]?.[0]).toBe(800)
    expect(drawing[1]?.[1]).toBe(1800)
    expect(drawing[1]?.[2]).toBeCloseTo(1600)
    expect(drawing[1]?.[3]).toBe(3000)
  })

  it('exports the shared smooth stroke, target rings, and compact square labels without edit handles', async () => {
    const paths: string[] = []
    const circles: number[][] = []
    const labels: number[][] = []
    const texts: string[] = []
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(path: string) {
          paths.push(path)
        }
      },
    )
    const context = {
      drawImage: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      arc: (...coordinates: number[]) => circles.push(coordinates),
      roundRect: (...coordinates: number[]) => labels.push(coordinates),
      stroke: () => undefined,
      fill: () => undefined,
      fillText: (text: string) => texts.push(text),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['png'], { type: 'image/png' })),
    )
    const pen: ImageAnnotation = {
      id: 'stroke',
      number: 1,
      kind: 'pen',
      points: [
        { x: 0.4, y: 0.3 },
        { x: 0.2, y: 0.5 },
        { x: 0.7, y: 0.8 },
      ],
    }
    const point: ImageAnnotation = {
      id: 'target',
      number: 2,
      kind: 'point',
      points: [{ x: 0.6, y: 0.4 }],
    }
    await exportAnnotatedImage('/frame.png', [pen, point])
    const size = { width: imageWidth, height: imageHeight }
    const exportScale = Math.min(imageWidth, imageHeight) / 480
    const penGeometry = annotationVisual(pen, size, exportScale)
    const pointGeometry = annotationVisual(point, size, exportScale)
    expect(paths).toEqual([penGeometry.penPath])
    expect(circles.map((circle) => circle.slice(0, 3))).toEqual([
      [pointGeometry.anchor.x, pointGeometry.anchor.y, pointGeometry.targetRadius],
      [pointGeometry.anchor.x, pointGeometry.anchor.y, pointGeometry.targetDotRadius],
    ])
    expect(labels).toHaveLength(2)
    expect(labels[0]?.slice(2, 4)).toEqual([50, 50])
    expect(texts).toEqual(['1', '2'])
  })

  it('reports unreadable source images', async () => {
    imageFails = true
    await expect(exportAnnotatedImage('/unreadable.png', [])).rejects.toThrow('原图无法读取')
  })

  it.each(['tainted', 'empty', 'oversized'] as const)(
    'rejects %s export instead of returning a usable input',
    async (failure) => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: () => undefined,
      } as unknown as CanvasRenderingContext2D)
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
        if (failure === 'tainted') throw new DOMException('Tainted canvas', 'SecurityError')
        callback(
          failure === 'empty'
            ? null
            : new Blob([new Uint8Array(16 * 1024 * 1024 + 1)], { type: 'image/png' }),
        )
      })
      await expect(exportAnnotatedImage('/frame.png', [])).rejects.toThrow(
        failure === 'oversized'
          ? '超过 16 MB'
          : failure === 'tainted'
            ? '不允许跨域导出'
            : '导出失败',
      )
    },
  )
})
