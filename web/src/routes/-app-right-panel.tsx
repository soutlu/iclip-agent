import { useState } from 'react'
import { IconButton } from '@/shared/ui/button'

/**
 * 应用右面板：每个登录页共享的外壳（面板头、内容区）。
 *
 * 结构对齐 Kimi Code Web 的右面板：460 宽、所有断点默认折叠（折叠后主区右上浮出展开钮，
 * 紧凑屏展开后成浮层）。面板内容（tab、文件 / 进度等）还没定，当前只有空态占位——
 * 见 design-system.html 04 · HOME。
 *
 * @returns 右面板与折叠态下的浮出展开按钮。
 */
export function AppRightPanel() {
  // 右面板默认折叠：面板尚无内容，展开由用户显式触发
  const [collapsed, setCollapsed] = useState(true)

  if (collapsed) {
    return (
      <IconButton
        className="layer-sidebar fixed top-3 right-3 bg-surface-container-lowest shadow-[var(--shadow-1)]"
        label="展开右侧面板"
        name="panel-right"
        onClick={() => setCollapsed(false)}
        size="md"
      />
    )
  }

  return (
    <aside
      aria-label="右侧面板"
      className="layer-sidebar flex h-dvh w-(--layout-app-right-panel-width) shrink-0 flex-col border-l border-border bg-background max-sm:fixed max-sm:top-0 max-sm:right-0 max-sm:shadow-[var(--shadow-2)] sm:sticky sm:top-0"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
        <h2 className="px-1 text-label font-semibold tracking-wide text-on-surface-variant">
          面板
        </h2>
        <IconButton
          label="折叠右侧面板"
          name="panel-right"
          onClick={() => setCollapsed(true)}
          size="md"
        />
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <p className="text-body-sm text-on-surface-variant">还没有面板内容</p>
      </div>
    </aside>
  )
}
