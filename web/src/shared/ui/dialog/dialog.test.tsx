import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DialogHeader, DialogRoot, DialogSurface } from './dialog'

const fileDrag = () => ({ dropEffect: '', files: [], items: [], types: ['Files'] })

describe('DialogSurface 对文件拖放', () => {
  it('弹窗本体与遮罩都标成禁止落点，drop 带着 defaultPrevented 冒出去', () => {
    render(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭" title="编辑图片" />
        </DialogSurface>
      </DialogRoot>,
    )
    const dialog = screen.getByRole('dialog', { name: '编辑图片' })
    const overlay = dialog.previousElementSibling
    if (overlay === null) throw new Error('Radix 把遮罩渲染在弹窗本体前面')
    for (const target of [dialog, overlay]) {
      const dataTransfer = fileDrag()
      fireEvent.dragOver(target, { dataTransfer })
      expect(dataTransfer.dropEffect).toBe('none')
      const drop = createEvent.drop(target, { dataTransfer: fileDrag() })
      fireEvent(target, drop)
      expect(drop.defaultPrevented).toBe(true)
    }
  })

  it('弹窗里自己的拖放区先接管的，弹窗不再改写它的落点效果', () => {
    render(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭" title="编辑图片" />
          <div
            data-testid="zone"
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }}
          />
        </DialogSurface>
      </DialogRoot>,
    )
    const dataTransfer = fileDrag()
    fireEvent.dragOver(screen.getByTestId('zone'), { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  it('拖的不是文件时不插手', () => {
    render(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭" title="编辑图片" />
        </DialogSurface>
      </DialogRoot>,
    )
    const dialog = screen.getByRole('dialog', { name: '编辑图片' })
    const dataTransfer = { dropEffect: '', types: ['text/plain'] }
    const over = createEvent.dragOver(dialog, { dataTransfer })
    fireEvent(dialog, over)
    expect(over.defaultPrevented).toBe(false)
    expect(dataTransfer.dropEffect).toBe('')
  })
})
