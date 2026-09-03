/**
 * 壳里两列之间的拖柄：侧栏｜主区 一道，聊天｜右面板 一道。
 *
 * 指针按下之后监听 window 而不是自己：拖快了指针会跑到别的元素上，只听自身的话拖动会中途断掉。
 * 拖柄本身不记宽度——它只报「相对按下那一刻移动了多少」，宽度与夹取规则都在壳里（见 `_shell.tsx`）。
 */

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'

/** 键盘一次调多少。够看出变化，又不会一下顶到边界。 */
const KEY_STEP = 16

type AppResizeHandleProps = {
  label: string
  /** 当前宽度，只用来报给读屏。 */
  value: number
  min: number
  max: number
  /** 指针按下：调用方记下这一刻的宽度当基准。 */
  onResizeStart: () => void
  /** 相对按下那一刻移动了多少像素（向右为正）。 */
  onResize: (delta: number) => void
  /** 拖完了：调用方落盘。 */
  onResizeEnd: () => void
  /** 双击恢复默认宽。 */
  onReset: () => void
}

/**
 * 渲染一道拖柄。
 *
 * @param props - 组件属性。
 * @param props.label - 读屏用的名字。
 * @param props.value - 当前宽度。
 * @param props.min - 宽度下限。
 * @param props.max - 宽度上限。
 * @param props.onResizeStart - 指针按下。
 * @param props.onResize - 拖动中的位移。
 * @param props.onResizeEnd - 拖动结束。
 * @param props.onReset - 恢复默认宽。
 * @returns 拖柄。
 */
export function AppResizeHandle({
  label,
  max,
  min,
  onReset,
  onResize,
  onResizeEnd,
  onResizeStart,
  value,
}: AppResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  // 拖到一半组件被卸载（切路由、面板收起）时得把 window 上的监听摘掉，否则它会一直跟着指针跑。
  const detachRef = useRef<(() => void) | null>(null)
  useEffect(() => () => detachRef.current?.(), [])

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const origin = event.clientX
    onResizeStart()
    setDragging(true)
    const move = (moved: PointerEvent) => onResize(moved.clientX - origin)
    const stop = () => {
      detachRef.current?.()
      detachRef.current = null
      setDragging(false)
      onResizeEnd()
    }
    detachRef.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const nudge = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0
    if (step === 0) return
    event.preventDefault()
    onResizeStart()
    onResize(step)
    onResizeEnd()
  }

  return (
    // 用 button 而不是 role="separator"：ARIA 的 window splitter 本该是可聚焦的交互件，但
    // jsx-a11y 把 separator 一律当非交互，给它挂事件就报错。button 天然可聚焦、可按键。
    <button
      aria-label={label}
      className="group layer-canvas relative w-1 shrink-0 cursor-col-resize touch-none ui-focus select-none"
      onDoubleClick={onReset}
      onKeyDown={nudge}
      onPointerDown={startDrag}
      title={`${label}（当前 ${value}px，可拖动 ${min}–${max}，双击恢复默认）`}
      type="button"
    >
      {/* 静息不画线：两列之间本来就有发丝边框，再画一道会变成双线 */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-px ui-motion-s',
          dragging ? 'bg-border-hover' : 'bg-transparent group-hover:bg-border-hover',
        )}
      />
    </button>
  )
}
