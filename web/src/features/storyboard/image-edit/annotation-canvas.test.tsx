import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { AnnotationCanvas } from './annotation-canvas'
import type { ImageAnnotation } from './image-edit-types'

const original: ImageAnnotation = {
  id: 'jacket',
  number: 1,
  kind: 'rectangle',
  points: [
    { x: 0.2, y: 0.3 },
    { x: 0.6, y: 0.8 },
  ],
}

function Editor({
  initial = [],
  disabled = false,
}: {
  initial?: ImageAnnotation[]
  disabled?: boolean
}) {
  const [annotations, setAnnotations] = useState(initial)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return (
    <AnnotationCanvas
      url="/frame.png"
      annotations={annotations}
      onChange={setAnnotations}
      selectedId={selectedId}
      onSelect={setSelectedId}
      disabled={disabled}
    />
  )
}

function loadImage() {
  const image = screen.getByRole('img', { name: '当前编辑帧' })
  Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 800 } })
  fireEvent.load(image)
  const canvas = screen.getByRole('group', { name: '图片标注画布' })
  Object.assign(canvas, {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  return canvas
}

beforeEach(() => {
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      readonly pointerId = 1
    },
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('annotation canvas', () => {
  it('draws one gesture, ignores letterboxing, and supports delete with undo/redo', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Editor />)
    const canvas = loadImage()
    await user.click(screen.getByRole('button', { name: '椭圆标注' }))
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 20, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100, button: 0 })
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    fireEvent.pointerDown(canvas, { clientX: 280, clientY: 240, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 440, clientY: 640 })
    fireEvent.pointerUp(canvas, { clientX: 440, clientY: 640 })
    expect(screen.getByRole('button', { name: '标注 1' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '撤销标注' }))
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重做标注' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '标注 1' }), { key: 'Enter' })
    fireEvent.keyDown(canvas, { key: 'Delete' })
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true })
    expect(screen.getByRole('button', { name: '标注 1' })).toBeInTheDocument()
  })

  it('moves and resizes the selected mark while preserving its reference identity', async () => {
    await renderWithProviders(<Editor initial={[original]} />)
    const canvas = loadImage()
    const mark = screen.getByRole('button', { name: '标注 1' })
    fireEvent.pointerDown(mark, { clientX: 300, clientY: 300, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 340, clientY: 380 })
    fireEvent.pointerUp(canvas, { clientX: 340, clientY: 380 })
    expect(mark).toHaveAttribute('data-annotation-id', 'jacket')
    expect(Number(mark.querySelector('rect')?.getAttribute('x'))).toBeCloseTo(120)
    const handle = mark.querySelector('[data-handle="2"]')
    if (!handle) throw new Error('Missing resize handle')
    fireEvent.pointerDown(handle, { clientX: 480, clientY: 720, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 560, clientY: 760 })
    fireEvent.pointerUp(canvas, { clientX: 560, clientY: 760 })
    expect(Number(mark.querySelector('rect')?.getAttribute('width'))).toBeCloseTo(240)
    fireEvent.keyDown(canvas, { key: 'z', metaKey: true })
    expect(Number(mark.querySelector('rect')?.getAttribute('width'))).toBeCloseTo(160)
  })

  it('discards a cancelled stroke without changing the committed annotation', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Editor initial={[original]} />)
    const canvas = loadImage()
    await user.click(screen.getByRole('button', { name: '自由画笔' }))
    fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 340, clientY: 380 })
    fireEvent.pointerCancel(canvas)
    expect(screen.queryByRole('button', { name: '标注 2' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标注 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销标注' })).toBeDisabled()
  })

  it('shows image failures and disallows drawing while the editor is busy', async () => {
    await renderWithProviders(<Editor initial={[original]} disabled />)
    const canvas = loadImage()
    expect(screen.getByRole('button', { name: '矩形标注' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('button', { name: '标注 1' }), { key: 'Enter' })
    fireEvent.keyDown(canvas, { key: 'Delete' })
    expect(screen.getByRole('button', { name: '标注 1' })).toBeInTheDocument()
    fireEvent.error(screen.getByRole('img', { name: '当前编辑帧' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '图片标注画布' })).not.toBeInTheDocument()
  })
})
