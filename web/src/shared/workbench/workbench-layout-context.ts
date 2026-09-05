/** 壳根据视口、当前侧栏宽度及聊天和面板最小宽度计算并排条件，宿主只消费结果。 */

import { createContext } from 'react'

export interface WorkbenchLayout {
  sideBySide: boolean
  compact: boolean
  /** 报告面板是否占据布局空间，供壳控制拖柄。 */
  onPanelVisible?: (visible: boolean) => void
}

/** 壳之外默认使用非紧凑、可并排布局。 */
export const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayout = { compact: false, sideBySide: true }

export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null)
