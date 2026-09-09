import { use } from 'react'
import type { ArtifactRegistry } from './registry'
import { WorkbenchRegistryContext } from './workbench-registry-context'

export const useWorkbenchRegistry = (): ArtifactRegistry => {
  const registry = use(WorkbenchRegistryContext)
  if (registry === null) throw new Error('useWorkbenchRegistry 要在 WorkbenchRegistryProvider 里用')
  return registry
}
