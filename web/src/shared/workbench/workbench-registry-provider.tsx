import type { ReactNode } from 'react'
import type { ArtifactRegistry } from './registry'
import { WorkbenchRegistryContext } from './workbench-registry-context'

type WorkbenchRegistryProviderProps = {
  children: ReactNode
  registry: ArtifactRegistry
}

export function WorkbenchRegistryProvider({ children, registry }: WorkbenchRegistryProviderProps) {
  return <WorkbenchRegistryContext value={registry}>{children}</WorkbenchRegistryContext>
}
