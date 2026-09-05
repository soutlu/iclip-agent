/** app 创建并注册具体类型，通过 Context 注入 shared 宿主。 */

import { createContext } from 'react'
import type { ArtifactRegistry } from './registry'

export const WorkbenchRegistryContext = createContext<ArtifactRegistry | null>(null)
