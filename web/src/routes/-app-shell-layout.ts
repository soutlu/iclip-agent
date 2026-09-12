// 数值与 design-system.html 的 --layout-app-* 对齐。
export const SIDEBAR_WIDTH = { default: 264, min: 200, max: 400 } as const
export const WORKBENCH_WIDTH = { default: 820, min: 560 } as const
export const COMPACT_MAX = 600
export const APP_RESIZE_HANDLE_WIDTH = 4

const CHAT_MIN = 400

export const clampWidth = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

type ShellLayoutInput = {
  viewport: number
  sidebarCollapsed: boolean
  sidebarWidth: number
  workbenchWidth: number
}

/** 预留聊天区和拖柄后计算面板宽度；紧凑屏侧栏覆盖主区，不占并排空间。 */
export function resolveShellLayout({
  viewport,
  sidebarCollapsed,
  sidebarWidth,
  workbenchWidth,
}: ShellLayoutInput) {
  const sidebar = clampWidth(sidebarWidth, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)
  const compact = viewport < COMPACT_MAX
  const occupiedBySidebar = sidebarCollapsed || compact ? 0 : sidebar + APP_RESIZE_HANDLE_WIDTH
  const availableForWorkbench = viewport - occupiedBySidebar - CHAT_MIN - APP_RESIZE_HANDLE_WIDTH
  const workbenchMax = Math.max(WORKBENCH_WIDTH.min, availableForWorkbench)

  return {
    compact,
    sideBySide: availableForWorkbench >= WORKBENCH_WIDTH.min,
    sidebarWidth: sidebar,
    workbenchMax,
    workbenchWidth: clampWidth(workbenchWidth, WORKBENCH_WIDTH.min, workbenchMax),
  }
}
