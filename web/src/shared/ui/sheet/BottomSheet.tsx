import type { ReactNode, TouchEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'

type BottomSheetSnap = 'minimized' | 'partial' | 'full'

interface BottomSheetSnapConfig {
  full: number
  minimized: number
  partial: number
}

interface BottomSheetProps {
  children: ReactNode
  /** 拖拽手柄区域 — 放在 sheet 顶部 */
  handle?: ReactNode
  /** 各 snap 对应的高度百分比 (vh) */
  snapHeights?: BottomSheetSnapConfig
  /** 初始 snap 状态 */
  defaultSnap?: BottomSheetSnap
  /** snap 状态变化回调 */
  onSnapChange?: (snap: BottomSheetSnap) => void
  /** full 状态下是否显示背景遮罩 */
  showOverlay?: boolean
  /** 额外 className */
  className?: string
}

const DEFAULT_SNAPS: BottomSheetSnapConfig = {
  full: 90,
  minimized: 8,
  partial: 40,
}

const SWIPE_THRESHOLD = 50

const SNAP_UP: Record<BottomSheetSnap, BottomSheetSnap> = {
  minimized: 'partial',
  partial: 'full',
  full: 'full',
}

const SNAP_DOWN: Record<BottomSheetSnap, BottomSheetSnap> = {
  full: 'partial',
  partial: 'minimized',
  minimized: 'minimized',
}

export default function BottomSheet({
  children,
  className = '',
  defaultSnap = 'minimized',
  handle,
  onSnapChange,
  showOverlay = true,
  snapHeights = DEFAULT_SNAPS,
}: BottomSheetProps) {
  const [snap, setSnap] = useState<BottomSheetSnap>(defaultSnap)
  const [isDragging, setIsDragging] = useState(false)
  const [startY, setStartY] = useState(0)
  const [currentY, setCurrentY] = useState(0)
  const [startedFromHandle, setStartedFromHandle] = useState(false)
  const handleRef = useRef<HTMLDivElement>(null)

  const changeSnap = (next: BottomSheetSnap) => {
    setSnap(next)
    onSnapChange?.(next)
  }

  const height = useMemo(() => {
    if (!isDragging) return snapHeights[snap]

    const deltaY = startY - currentY
    const nextHeight = snapHeights[snap] + (deltaY / window.innerHeight) * 100

    return Math.max(snapHeights.minimized, Math.min(snapHeights.full, nextHeight))
  }, [currentY, isDragging, snap, snapHeights, startY])

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    const inHandle = handleRef.current?.contains(event.target as Node) ?? false

    if (!touch) return
    if (snap !== 'minimized' && !inHandle) return

    setStartedFromHandle(inHandle)
    setIsDragging(true)
    setStartY(touch.clientY)
    setCurrentY(touch.clientY)
  }

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    if (!isDragging) return
    if (snap !== 'minimized' && !startedFromHandle) return

    const touch = event.touches[0]

    if (!touch) return

    setCurrentY(touch.clientY)
  }

  const handleTouchEnd = () => {
    if (!isDragging) return
    setIsDragging(false)
    setStartedFromHandle(false)

    if (snap !== 'minimized' && !startedFromHandle) return

    const deltaY = startY - currentY

    if (deltaY > SWIPE_THRESHOLD) {
      changeSnap(SNAP_UP[snap])
      return
    }

    if (deltaY < -SWIPE_THRESHOLD) {
      changeSnap(SNAP_DOWN[snap])
    }
  }

  const toggleSnap = () => {
    changeSnap(snap === 'full' ? 'partial' : snap === 'minimized' ? 'partial' : 'full')
  }

  return (
    <div
      className={cn(
        'layer-panel fixed right-0 bottom-0 left-0 rounded-t-2xl border-t border-border bg-background shadow-[var(--shadow-3)] transition-all duration-[var(--dur-m)] ease-[var(--ease)]',
        className,
      )}
      style={{ height: `${height}vh`, touchAction: isDragging ? 'none' : 'auto' }}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onTouchStart={handleTouchStart}
    >
      {/* 拖拽手柄 */}
      <div ref={handleRef} className="flex items-center gap-2 px-4 py-2">
        {handle ?? (
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-center"
            onClick={toggleSnap}
            aria-label="切换面板状态"
          >
            <div
              className="mb-2 h-1 w-12 rounded-full"
              style={{ backgroundColor: 'var(--color-on-surface-variant)', opacity: 0.6 }}
            />
          </button>
        )}
      </div>

      {/* 内容区 */}
      <div
        className={cn(
          'overflow-hidden transition-opacity ui-motion-m',
          snap === 'minimized' ? 'opacity-0' : 'opacity-100',
        )}
        style={{ height: 'calc(100% - 48px)' }}
      >
        <div className="h-full overflow-y-auto px-4 pb-4">{children}</div>
      </div>

      {/* 遮罩层 */}
      {showOverlay && snap === 'full' && (
        <button
          type="button"
          className="fixed inset-0 -z-10 bg-black/20"
          onClick={() => changeSnap('partial')}
          aria-label="收起面板"
        />
      )}
    </div>
  )
}
