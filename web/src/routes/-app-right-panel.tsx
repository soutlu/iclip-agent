import { useMatches } from '@tanstack/react-router'

/** 取最深匹配路由的 staticData.rightPanel；没声明的页面没有右面板。 */
export function AppRightPanel() {
  const matches = useMatches()
  // 子路由面板覆盖父路由声明。
  const Panel = [...matches].reverse().find((match) => match.staticData.rightPanel !== undefined)
    ?.staticData.rightPanel

  return Panel === undefined ? null : <Panel />
}
