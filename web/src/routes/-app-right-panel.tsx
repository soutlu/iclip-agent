import { useMatches } from '@tanstack/react-router'
import { useState } from 'react'
import { IconButton } from '@/shared/ui/button'

/**
 * 应用右面板：每页共享的外壳槽位。
 *
 * 槽位由当前路由的 `staticData.rightPanel` 填——取最深那一个匹配，声明了就整块交给它（几何也归
 * 它管）。没有声明的页面保持折叠空态：460 宽、默认折叠、折叠后主区右上浮出展开钮。
 * 见 design-system.html 04 · HOME。
 *
 * @returns 路由声明的面板内容，或折叠空态与它的展开按钮。
 */
export function AppRightPanel() {
  const matches = useMatches()
  // 深的盖浅的：父路由声明了通用面板时，子路由能就地换掉它。
  const Panel = [...matches].reverse().find((match) => match.staticData.rightPanel !== undefined)
    ?.staticData.rightPanel

  // 右面板默认折叠：面板尚无内容，展开由用户显式触发
  const [collapsed, setCollapsed] = useState(true)

  if (Panel !== undefined) return <Panel />

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
      className="layer-sidebar flex h-dvh w-(--layout-app-right-panel-width) shrink-0 flex-col border-l-[0.5px] border-border bg-background max-sm:fixed max-sm:top-0 max-sm:right-0 max-sm:shadow-[var(--shadow-2)] sm:sticky sm:top-0"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
        <h2 className="px-1 text-label font-semibold tracking-wide text-on-surface-faint">面板</h2>
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
