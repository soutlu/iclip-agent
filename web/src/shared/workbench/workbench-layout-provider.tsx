import type { ReactNode } from 'react'
import { WorkbenchLayoutContext, type WorkbenchLayout } from './workbench-layout-context'

type WorkbenchLayoutProviderProps = {
  children: ReactNode
  layout: WorkbenchLayout
}

export function WorkbenchLayoutProvider({ children, layout }: WorkbenchLayoutProviderProps) {
  return <WorkbenchLayoutContext value={layout}>{children}</WorkbenchLayoutContext>
}
