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

// bare 的契约就是不输出那几个表面类，jsdom 不跑 Tailwind，类名是这里唯一的可观察边界。
describe('DialogSurface 的无表面变体', () => {
  const surfaceOf = (bare: boolean) => {
    render(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined} bare={bare} className="task-detail-dialog">
          <DialogHeader closeLabel="关闭" title="需求详情" />
        </DialogSurface>
      </DialogRoot>,
    )
    return screen.getByRole('dialog', { name: '需求详情' })
  }

  it('默认画圆角、底色与阴影', () => {
    const dialog = surfaceOf(false)
    for (const className of [
      'rounded-2xl',
      'bg-surface-container-lowest',
      'shadow-[var(--shadow-3)]',
      'overflow-hidden',
    ]) {
      expect(dialog).toHaveClass(className)
    }
  })

  it('bare 只去掉表面，定位与调用方类名照旧，prop 不落到 DOM 上', () => {
    const dialog = surfaceOf(true)
    for (const className of [
      'rounded-2xl',
      'bg-surface-container-lowest',
      'shadow-[var(--shadow-3)]',
      'overflow-hidden',
    ]) {
      expect(dialog).not.toHaveClass(className)
    }
    expect(dialog).toHaveClass('layer-popup', 'fixed', 'task-detail-dialog')
    expect(dialog).not.toHaveAttribute('bare')
  })
})
