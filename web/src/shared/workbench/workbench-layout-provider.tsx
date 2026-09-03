import type { ReactNode } from 'react'
import { WorkbenchLayoutContext, type WorkbenchLayout } from './workbench-layout-context'

type WorkbenchLayoutProviderProps = {
  children: ReactNode
  layout: WorkbenchLayout
}

/**
 * 把壳算好的几何交给面板宿主。
 *
 * @param props - Provider 属性。
 * @param props.children - 子树。
 * @param props.layout - 几何事实。
 * @returns Provider。
 */
export function WorkbenchLayoutProvider({ children, layout }: WorkbenchLayoutProviderProps) {
  return <WorkbenchLayoutContext value={layout}>{children}</WorkbenchLayoutContext>
}
