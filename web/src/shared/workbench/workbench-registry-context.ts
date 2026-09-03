/**
 * 注册表实例的存放处。实例由 `app/` 层建并登记具体类型——宿主在 `shared/`，不认识任何 feature。
 */

import { createContext } from 'react'
import type { ArtifactRegistry } from './registry'

export const WorkbenchRegistryContext = createContext<ArtifactRegistry | null>(null)
