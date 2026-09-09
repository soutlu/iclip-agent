/** 壳把两侧的开合状态告诉页面：侧栏收起时页头左端要给展开钮留位，右面板收起时右端要给面板菜单钮留位。 */

import { createContext, use } from 'react'

export interface ShellChrome {
  sidebarCollapsed: boolean
  /** 右面板正占着布局位；收起或盖在聊天上面时都算不占。 */
  panelVisible: boolean
}

/** 没有壳（组件单测）时按两侧都开着算，页头不留位。 */
const DEFAULT_SHELL_CHROME: ShellChrome = { panelVisible: true, sidebarCollapsed: false }

export const ShellChromeContext = createContext<ShellChrome>(DEFAULT_SHELL_CHROME)

export const useShellChrome = (): ShellChrome => use(ShellChromeContext)
