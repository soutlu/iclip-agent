/** 拖动监听 window，防止指针离开拖柄后中断；仅上报相对位移，宽度与边界由壳管理。 */

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'

const KEY_STEP = 16

type AppResizeHandleProps = {
  label: string
  /** 当前宽度用于可访问说明。 */
  value: number
  min: number
  max: number
  /** 开始拖动时记录基准宽度。 */
  onResizeStart: () => void
  onResize: (delta: number) => void
  onResizeEnd: () => void
  onReset: () => void
}

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
  // 卸载时清理 window 监听器，避免拖动状态残留。
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
    // 使用原生 button 提供键盘交互；jsx-a11y 将 separator 视为非交互角色。
    <button
      aria-label={label}
      className="group layer-canvas relative w-1 shrink-0 cursor-col-resize touch-none ui-focus select-none"
      onDoubleClick={onReset}
      onKeyDown={nudge}
      onPointerDown={startDrag}
      title={`${label}（当前 ${value}px，可拖动 ${min}–${max}，双击恢复默认）`}
      type="button"
    >
      {/* 非交互时不叠加分隔线，避免与列边框重合。 */}
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
