import type { ReactNode } from 'react'
import type { ArtifactRegistry } from './registry'
import { WorkbenchRegistryContext } from './workbench-registry-context'

type WorkbenchRegistryProviderProps = {
  children: ReactNode
  registry: ArtifactRegistry
}

/**
 * 把产物类型注册表交给子树。
 *
 * @param props - Provider 属性。
 * @param props.children - 子树。
 * @param props.registry - 注册表实例。
 * @returns Provider。
 */
export function WorkbenchRegistryProvider({ children, registry }: WorkbenchRegistryProviderProps) {
  return <WorkbenchRegistryContext value={registry}>{children}</WorkbenchRegistryContext>
}
