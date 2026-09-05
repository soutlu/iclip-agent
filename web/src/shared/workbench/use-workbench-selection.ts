import { use } from 'react'
import type { WorkbenchSelection } from './workbench-selection-context'
import { WorkbenchSelectionContext } from './workbench-selection-context'

export const useWorkbenchSelection = (): WorkbenchSelection => {
  const selection = use(WorkbenchSelectionContext)
  if (selection === null) {
    throw new Error('useWorkbenchSelection 要在 WorkbenchSelectionProvider 里用')
  }
  return selection
}
