/** 拖柄仅验证位移和回调顺序；宽度边界与持久化由应用壳负责。 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppResizeHandle } from './-app-resize-handle'

const renderHandle = () => {
  const calls: string[] = []
  const deltas: number[] = []
  const { unmount } = render(
    <AppResizeHandle
      label="调整侧栏宽度"
      max={400}
      min={200}
      onReset={() => calls.push('reset')}
      onResize={(delta) => {
        calls.push('resize')
        deltas.push(delta)
      }}
      onResizeEnd={() => calls.push('end')}
      onResizeStart={() => calls.push('start')}
      value={264}
    />,
  )
  return { calls, deltas, handle: screen.getByRole('button', { name: '调整侧栏宽度' }), unmount }
}

describe('AppResizeHandle', () => {
  it('按下之后跟着指针走，松开报一次结束', () => {
    const { calls, deltas, handle } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerMove(window, { clientX: 340 })
    fireEvent.pointerMove(window, { clientX: 260 })
    fireEvent.pointerUp(window)

    expect(deltas).toEqual([40, -40])
    expect(calls).toEqual(['start', 'resize', 'resize', 'end'])
  })

  it('松开之后指针再动也不跟了', () => {
    const { deltas, handle } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerUp(window)
    fireEvent.pointerMove(window, { clientX: 500 })

    expect(deltas).toEqual([])
  })

  it('右键不起拖：拖动只认左键', () => {
    const { calls, handle } = renderHandle()

    fireEvent.pointerDown(handle, { button: 2, clientX: 300 })
    fireEvent.pointerMove(window, { clientX: 400 })

    expect(calls).toEqual([])
  })

  it('双击是恢复默认宽', async () => {
    const { calls, handle } = renderHandle()

    await userEvent.dblClick(handle)

    expect(calls).toContain('reset')
  })

  it('左右方向键各调一步，键盘也能改宽', () => {
    const { calls, deltas, handle } = renderHandle()

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'Enter' })

    expect(deltas).toEqual([16, -16])
    expect(calls).toEqual(['start', 'resize', 'end', 'start', 'resize', 'end'])
  })

  it('拖到一半被卸载也不再跟着指针跑', () => {
    const { deltas, handle, unmount } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    unmount()
    fireEvent.pointerMove(window, { clientX: 400 })

    expect(deltas).toEqual([])
  })
})
