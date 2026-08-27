import { useState } from 'react'
import { useProjectCanvasStore } from '@/features/project-canvas'
import { cn } from '@/shared/lib/utils'
import { MenuRoot, MenuTrigger } from '@/shared/ui/menu'
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
    'flex items-center justify-center backdrop-blur-md border border-border rounded-full transition-all ui-motion-s text-on-background bg-header-btn-bg hover:bg-hover'

  return (
    <div className="layer-content flex items-center gap-2">
      {/* 缩放百分比 — 点击弹出菜单 */}
      <div className="relative">
        <MenuRoot modal={false} open={isZoomMenuOpen} onOpenChange={setIsZoomMenuOpen}>
          <MenuTrigger asChild>
            <button
              type="button"
              className={cn(btnBase, 'h-8 w-16 px-1.5 shadow-[var(--shadow-2)]')}
              aria-label="缩放级别"
            >
              <span className="text-body font-medium">{zoomLevel}%</span>
            </button>
          </MenuTrigger>
          {isZoomMenuOpen && <ZoomMenu onClose={() => setIsZoomMenuOpen(false)} />}
        </MenuRoot>
      </div>
    </div>
  )
}
