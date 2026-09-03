import { use } from 'react'
import type { WorkbenchSelection } from './workbench-selection-context'
import { WorkbenchSelectionContext } from './workbench-selection-context'

/**
 * 取当前选中的组 / 帧。
 *
 * @returns 当前选中与改它的几个方法。
 */
export const useWorkbenchSelection = (): WorkbenchSelection => {
  const selection = use(WorkbenchSelectionContext)
  if (selection === null) {
    throw new Error('useWorkbenchSelection 要在 WorkbenchSelectionProvider 里用')
  }
  return selection
}
