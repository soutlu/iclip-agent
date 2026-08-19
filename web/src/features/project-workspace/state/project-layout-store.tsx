import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { PROJECT_PAGE_LAYOUT } from '@/features/project-workspace/utils/project-page.constants'

const clampSidebarWidth = (width: number) =>
  Math.min(
    PROJECT_PAGE_LAYOUT.desktopSidebarMax,
    Math.max(PROJECT_PAGE_LAYOUT.desktopSidebarMin, width),
  )

export interface ProjectLayoutState {
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
}

export type ProjectLayoutStore = StoreApi<ProjectLayoutState>

export const createProjectLayoutStore = () =>
  createStore<ProjectLayoutState>((set) => ({
    sidebarWidth: PROJECT_PAGE_LAYOUT.desktopSidebarDefault,
    setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: clampSidebarWidth(sidebarWidth) }),
  }))

const ProjectLayoutStoreContext = createContext<ProjectLayoutStore | null>(null)

export function ProjectLayoutStoreProvider({
  children,
  store,
}: {
  children: ReactNode
  store: ProjectLayoutStore
}) {
  return (
    <ProjectLayoutStoreContext.Provider value={store}>
      {children}
    </ProjectLayoutStoreContext.Provider>
  )
}

export const useProjectLayoutStore = <T,>(selector: (state: ProjectLayoutState) => T) => {
  const store = useContext(ProjectLayoutStoreContext)

  if (!store) {
    throw new Error('useProjectLayoutStore 必须在 ProjectLayoutStoreProvider 内使用。')
  }

  return useStore(store, selector)
}
