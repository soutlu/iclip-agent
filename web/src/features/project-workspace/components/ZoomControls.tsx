import { Popover } from 'radix-ui'
import { useState } from 'react'
import { useProjectCanvasStore } from '@/features/project-canvas'
import { cn } from '@/shared/lib/utils'
import ZoomMenu from './ZoomMenu'

/**
 * 渲染项目画布右下角的缩放控制组。
 *
 * @returns 画布底部缩放控制组元素。
 */
export default function ZoomControls() {
  const zoomLevel = useProjectCanvasStore((state) => state.zoomLevel)
  const [isZoomMenuOpen, setIsZoomMenuOpen] = useState(false)

  /* 按钮基础样式 */
  const btnBase =
    'flex items-center justify-center backdrop-blur-md border border-[var(--color-border)] rounded-full transition-all duration-75 ease-out text-[var(--color-on-background)] bg-[var(--color-header-btn-bg)] hover:bg-[var(--color-hover)]'

  return (
    <div className="layer-content flex items-center gap-2">
      {/* 缩放百分比 — 点击弹出菜单 */}
      <div className="relative">
        <Popover.Root modal={false} open={isZoomMenuOpen} onOpenChange={setIsZoomMenuOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={cn(btnBase, 'h-8 w-16 px-1.5 shadow-[var(--shadow-2)]')}
              aria-label="缩放级别"
            >
              <span className="text-sm font-medium">{zoomLevel}%</span>
            </button>
          </Popover.Trigger>
          {isZoomMenuOpen && <ZoomMenu onClose={() => setIsZoomMenuOpen(false)} />}
        </Popover.Root>
      </div>
    </div>
  )
}
