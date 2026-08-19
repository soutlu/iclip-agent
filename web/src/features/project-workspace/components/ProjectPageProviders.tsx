import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { createProjectComposerStore, ProjectComposerStoreProvider } from '@/features/chat'
import { createProjectCanvasStore, ProjectCanvasStoreProvider } from '@/features/project-canvas'
import {
  createProjectLayoutStore,
  ProjectLayoutStoreProvider,
} from '@/features/project-workspace/state/project-layout-store'

interface ProjectPageProvidersProps {
  children: ReactNode
  projectId: string
}

/**
 * 提供单个项目 session 的画布与布局 store。
 *
 * @param props - Provider 属性。
 * @param props.children - 需要读取布局或画布 store 的子树。
 * @param props.projectId - 当前项目 session id，用于隔离画布持久化。
 * @returns 项目工作区 store Provider。
 */
export function ProjectWorkspaceProviders({ children, projectId }: ProjectPageProvidersProps) {
  const layoutStore = useMemo(() => createProjectLayoutStore(), [])
  const canvasStore = useMemo(() => createProjectCanvasStore(projectId), [projectId])

  return (
    <ProjectLayoutStoreProvider store={layoutStore}>
      <ProjectCanvasStoreProvider store={canvasStore}>{children}</ProjectCanvasStoreProvider>
    </ProjectLayoutStoreProvider>
  )
}

/**
 * 提供完整项目页 store，保留给需要一次性装配 composer、布局和画布的调用方。
 *
 * @param props - Provider 属性。
 * @param props.children - 项目页子树。
 * @param props.projectId - 当前项目 session id。
 * @returns 完整项目页 Provider。
 */
export default function ProjectPageProviders({ children, projectId }: ProjectPageProvidersProps) {
  const composerStore = useMemo(() => createProjectComposerStore(), [])

  return (
    <ProjectComposerStoreProvider store={composerStore}>
      <ProjectWorkspaceProviders projectId={projectId}>{children}</ProjectWorkspaceProviders>
    </ProjectComposerStoreProvider>
  )
}
