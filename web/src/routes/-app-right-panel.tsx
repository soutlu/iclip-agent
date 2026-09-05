import { useMatches } from '@tanstack/react-router'
import { useState } from 'react'
import { IconButton } from '@/shared/ui/button'

/** 取最深匹配路由的 staticData.rightPanel；未声明时显示可展开的空面板。 */
export function AppRightPanel() {
  const matches = useMatches()
  // 子路由面板覆盖父路由声明。
  const Panel = [...matches].reverse().find((match) => match.staticData.rightPanel !== undefined)
    ?.staticData.rightPanel

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
