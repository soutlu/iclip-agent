/**
 * 壳算好的几何事实，交给面板宿主。
 *
 * 「放不放得下并排」不是一个断点能定的：侧栏宽度可拖，所以条件是真实几何——
 * 视口 ≥ 侧栏当前宽 + 聊天最小宽 + 面板最小宽。算这件事只有壳有全部数据，宿主拿结论。
 */

import { createContext } from 'react'

export interface WorkbenchLayout {
  /** 聊天与面板放得下并排。放不下就是二选一。 */
  sideBySide: boolean
  /** 紧凑屏（< --breakpoint-sm）：右面板默认折叠。 */
  compact: boolean
  /** 宿主报回「面板此刻占不占布局位」：两列之间那道拖柄归壳画，它得知道面板在不在。 */
  onPanelVisible?: (visible: boolean) => void
}

/** 壳之外（单测直接渲染宿主）没有这份事实，按「放得下并排、不是紧凑屏」处理。 */
export const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayout = { compact: false, sideBySide: true }

export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null)
