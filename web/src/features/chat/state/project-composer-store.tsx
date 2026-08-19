import type { ReactNode } from 'react'
import { createContext, useContext, useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ComposerMediaNameSeed } from '@/shared/composer/composer-attachment.utils'
import {
  revokeComposerAttachmentObjectUrls,
  revokeRemovedComposerAttachmentObjectUrls,
} from '@/shared/composer/composer-attachment.utils'
import {
  createEmptyMediaComposerDraft,
  removeMediaComposerAttachment,
  reorderMediaComposerAttachments,
  type ComposerFileAttachment,
  type MediaComposerDocument,
  type MediaComposerDraft,
} from '@/shared/composer'

export interface ProjectComposerState extends MediaComposerDraft {
  addAttachments: (attachments: ComposerFileAttachment[]) => void
  adjustPendingUploadCount: (delta: number) => void
  attachmentErrorMessage?: string
  clearAttachmentErrorMessage: () => void
  clearDraftForSubmit: () => void
  clearRequestErrorMessage: () => void
  completeDraftSubmission: () => void
  focusRequestKey: number
  pendingUploadCount: number
  removeAttachment: (id: string, mediaNameSeeds: ComposerMediaNameSeed[]) => void
  reorderAttachments: (
    activeId: string,
    overId: string,
    mediaNameSeeds: ComposerMediaNameSeed[],
  ) => void
  requestErrorMessage?: string
  requestFocus: () => void
  restoreDraft: (draft: MediaComposerDraft) => void
  setAttachmentErrorMessage: (message: string | undefined) => void
  setDocument: (document: MediaComposerDocument) => void
  setRequestErrorMessage: (message: string | undefined) => void
}

export type ProjectComposerStore = StoreApi<ProjectComposerState> & {
  activate: () => void
  dispose: () => void
}

/**
 * 创建不含动作的空 Project Composer 状态片段。
 *
 * @returns 当前 schema 的空草稿、空错误和归零上传计数。
 */
const createEmptyProjectComposerState = () => ({
  ...createEmptyMediaComposerDraft(),
  attachmentErrorMessage: undefined,
  pendingUploadCount: 0,
  requestErrorMessage: undefined,
})

/**
 * 创建单个 project session 独占的 Composer store。
 *
 * @returns 保存结构化草稿、附件生命周期和错误状态的 Zustand store。
 */
export const createProjectComposerStore = (): ProjectComposerStore => {
  let active = true
  let inFlightAttachments: ComposerFileAttachment[] = []
  const store = createStore<ProjectComposerState>((set) => ({
    ...createEmptyProjectComposerState(),
    focusRequestKey: 0,
    addAttachments: (attachments) => {
      if (!active) {
        revokeComposerAttachmentObjectUrls(attachments)
        return
      }

      set((state) => ({ attachments: [...state.attachments, ...attachments] }))
    },
    adjustPendingUploadCount: (delta) =>
      set((state) => ({ pendingUploadCount: Math.max(0, state.pendingUploadCount + delta) })),
    clearAttachmentErrorMessage: () => set({ attachmentErrorMessage: undefined }),
    clearDraftForSubmit: () =>
      set((state) => {
        inFlightAttachments = state.attachments
        return createEmptyProjectComposerState()
      }),
    clearRequestErrorMessage: () => set({ requestErrorMessage: undefined }),
    completeDraftSubmission: () => {
      revokeComposerAttachmentObjectUrls(inFlightAttachments)
      inFlightAttachments = []
    },
    removeAttachment: (id, mediaNameSeeds) =>
      set((state) => {
        const nextDraft = removeMediaComposerAttachment(state, id, mediaNameSeeds)
        revokeRemovedComposerAttachmentObjectUrls(state.attachments, nextDraft.attachments)
        return nextDraft
      }),
    reorderAttachments: (activeId, overId, mediaNameSeeds) =>
      set((state) => reorderMediaComposerAttachments(state, activeId, overId, mediaNameSeeds)),
    requestFocus: () =>
      set((state) => ({
        focusRequestKey: state.focusRequestKey + 1,
      })),
    restoreDraft: (draft) => {
      if (!active) {
        return
      }

      revokeRemovedComposerAttachmentObjectUrls(store.getState().attachments, draft.attachments)
      inFlightAttachments = []
      set({
        ...draft,
        pendingUploadCount: 0,
      })
    },
    setAttachmentErrorMessage: (attachmentErrorMessage) => set({ attachmentErrorMessage }),
    setDocument: (document) => set({ document }),
    setRequestErrorMessage: (requestErrorMessage) => set({ requestErrorMessage }),
  }))

  return Object.assign(store, {
    activate: () => {
      active = true
    },
    dispose: () => {
      if (!active) {
        return
      }

      active = false
      revokeComposerAttachmentObjectUrls([...store.getState().attachments, ...inFlightAttachments])
      inFlightAttachments = []
      store.setState(createEmptyProjectComposerState())
    },
  })
}

const ProjectComposerStoreContext = createContext<ProjectComposerStore | null>(null)

export function ProjectComposerStoreProvider({
  children,
  store,
}: {
  children: ReactNode
  store: ProjectComposerStore
}) {
  useEffect(() => {
    store.activate()
    return () => store.dispose()
  }, [store])

  return (
    <ProjectComposerStoreContext.Provider value={store}>
      {children}
    </ProjectComposerStoreContext.Provider>
  )
}

export const useProjectComposerStoreApi = () => {
  const store = useContext(ProjectComposerStoreContext)

  if (!store) {
    throw new Error('useProjectComposerStoreApi 必须在 ProjectComposerStoreProvider 内使用。')
  }

  return store
}

export const useProjectComposerStore = <T,>(selector: (state: ProjectComposerState) => T) => {
  const store = useProjectComposerStoreApi()
  return useStore(store, selector)
}
