import type { ThreadAssistantMessage, ThreadMessage } from '@assistant-ui/react'
import { useAuiState, useThreadRuntime } from '@assistant-ui/react'
import { type AgUiResumeEntry, useAgUiInterrupts } from '@assistant-ui/react-ag-ui'
import type { ReactNode } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectArtifactDescriptor } from '@/features/artifacts'
import type { AgentOSSessionStatus } from '@/features/chat/api/agentos-runs'
import type { ProjectChatInterrupt } from '@/features/chat/contracts'
import type { ProducerProjectMediaItem } from '@/features/chat/project-state.types'
import {
  useProjectComposerStore,
  useProjectComposerStoreApi,
} from '@/features/chat/state/project-composer-store'
import {
  getProducerProjectSession,
  mergeProducerGenerationRecords,
  producerGenerationRecordsKey,
  useProducerGenerationFacts,
} from '@/features/projects'
import {
  createMediaComposerMessage,
  type MediaComposerDraft,
  type MediaComposerMessage,
  prepareComposerMessagePartsForSubmission,
} from '@/shared/composer'
import { DEFAULT_PROJECT_TITLE } from '../lib/project-chat.utils'
import {
  classifyProjectChatError,
  WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE,
} from '../lib/project-chat-error'
import { consumeProjectPendingDraft } from '../lib/project-pending-draft'
import { fetchProjectBusinessState } from '../runtime/project-agui-runtime'
import {
  createProjectAssistantUserMessage,
  projectConversationTimelineItemsFromAssistantMessages,
} from '../runtime/project-conversation-timeline'
import { producerProjectMediaToMediaComposerLibraryMedia } from '../runtime/project-state.adapters'
import { workspaceWriteResultsRevision } from '../runtime/project-workspace-tool-results'
import ProjectAssistantRuntimeProvider, {
  useProjectConnection,
  useProjectMemberSegments,
} from '../agui/provider'
import {
  type ProjectChatAskUserQuestionContextValue,
  ProjectChatActivityContext,
  type ProjectChatActivityContextValue,
  type ProjectChatComposerContextValue,
  ProjectChatActiveInterruptContext,
  ProjectChatAskUserQuestionContext,
  ProjectChatComposerContext,
  ProjectChatConversationContext,
  type ProjectChatConversationContextValue,
  ProjectChatResourcesContext,
  type ProjectChatResourcesContextValue,
  ProjectChatTitleContext,
  ProjectChatVideoGenerationContext,
  type ProjectChatVideoGenerationContextValue,
} from './project-chat-context'
import {
  interruptFromAgUiInterrupt,
  isAbortError,
  normalizeProducerProjectTitle,
  preserveEqualSerializableValue,
  throwIfSignalAborted,
} from './project-chat-provider.utils'

export {
  useProjectChatActiveInterrupt,
  useProjectChatActivity,
  useProjectChatAskUserQuestion,
  useProjectChatComposer,
  useProjectChatConversation,
  useProjectChatResources,
  useProjectChatTitle,
  useProjectChatVideoGeneration,
} from './project-chat-context'
import {
  useProjectInterruptActions,
  useProjectVideoGenerationActions,
} from './use-project-chat-actions'

interface ProjectChatProviderProps {
  children: ReactNode
  projectId: string
  sessionId: string
  sessionTitle?: string
}

interface ProjectChatBusinessProviderProps extends ProjectChatProviderProps {
  clearRuntimeError: () => void
  runtimeError: Error | null
}

const isMediaComposerDraftEmpty = ({ attachments, document }: MediaComposerDraft) =>
  attachments.length === 0 &&
  (document.content?.every((block) => (block.content?.length ?? 0) === 0) ?? true)

interface ProjectSessionRunObservation {
  errorMessage: string | null
  status: AgentOSSessionStatus | null
}

const projectSessionRunObservation = ({
  activeInterrupt,
  isHydrated,
  isRunning,
  messages,
}: {
  activeInterrupt: ProjectChatInterrupt | null
  isHydrated: boolean
  isRunning: boolean
  messages: readonly ThreadMessage[]
}): ProjectSessionRunObservation => {
  if (!isHydrated) {
    return { errorMessage: null, status: null }
  }

  if (activeInterrupt) {
    return { errorMessage: null, status: 'PAUSED' }
  }

  const latestAssistantMessage = messages.findLast(
    (message): message is ThreadAssistantMessage => message.role === 'assistant',
  )
  const messageStatus = latestAssistantMessage?.status

  if (isRunning || messageStatus?.type === 'running') {
    return { errorMessage: null, status: 'RUNNING' }
  }

  if (!messageStatus) {
    return { errorMessage: null, status: null }
  }

  if (messageStatus.type === 'requires-action') {
    return {
      errorMessage: null,
      status: messageStatus.reason === 'interrupt' ? 'PAUSED' : null,
    }
  }

  if (messageStatus.type === 'incomplete') {
    if (messageStatus.reason === 'cancelled') {
      return { errorMessage: null, status: 'CANCELLED' }
    }

    const errorMessage =
      typeof messageStatus.error === 'string' && messageStatus.error.trim().length > 0
        ? messageStatus.error
        : 'Agent 运行失败。'

    return { errorMessage, status: 'ERROR' }
  }

  return { errorMessage: null, status: 'COMPLETED' }
}

export default function ProjectChatProvider({
  children,
  projectId,
  sessionId,
  sessionTitle,
}: ProjectChatProviderProps) {
  const [runtimeError, setRuntimeError] = useState<Error | null>(null)

  return (
    <ProjectAssistantRuntimeProvider
      key={sessionId}
      onRuntimeError={setRuntimeError}
      sessionId={sessionId}
    >
      <ProjectChatBusinessProvider
        clearRuntimeError={() => setRuntimeError(null)}
        projectId={projectId}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        runtimeError={runtimeError}
      >
        {children}
      </ProjectChatBusinessProvider>
    </ProjectAssistantRuntimeProvider>
  )
}

function ProjectChatBusinessProvider({
  children,
  clearRuntimeError,
  projectId,
  sessionId,
  sessionTitle,
  runtimeError,
}: ProjectChatBusinessProviderProps) {
  const memberSegments = useProjectMemberSegments()
  const { state: connectionState } = useProjectConnection()
  const pendingAguiInterrupts = useAgUiInterrupts()
  const threadRuntime = useThreadRuntime()
  const aguiState = useAuiState((state) => state.thread.state)
  const threadMessages = useAuiState((state) => state.thread.messages)
  const threadIsRunning = useAuiState((state) => state.thread.isRunning)
  const composerStore = useProjectComposerStoreApi()
  const clearComposerRequestErrorMessage = useProjectComposerStore(
    (state) => state.clearRequestErrorMessage,
  )
  const clearComposerDraftForSubmit = useProjectComposerStore((state) => state.clearDraftForSubmit)
  const completeComposerDraftSubmission = useProjectComposerStore(
    (state) => state.completeDraftSubmission,
  )
  const composerDraftIsEmpty = useProjectComposerStore(isMediaComposerDraftEmpty)
  const pendingComposerUploadCount = useProjectComposerStore((state) => state.pendingUploadCount)
  const requestComposerFocus = useProjectComposerStore((state) => state.requestFocus)
  const restoreComposerDraft = useProjectComposerStore((state) => state.restoreDraft)
  const setComposerAttachmentErrorMessage = useProjectComposerStore(
    (state) => state.setAttachmentErrorMessage,
  )
  const setComposerRequestErrorMessage = useProjectComposerStore(
    (state) => state.setRequestErrorMessage,
  )
  const [assets, setAssets] = useState<Record<string, unknown>[]>([])
  const [generationRecords, setGenerationRecords] = useState<Record<string, unknown>[]>([])
  const [persistedArtifacts, setPersistedArtifacts] = useState<ProjectArtifactDescriptor[]>([])
  const [pendingInterruptResponses, setPendingInterruptResponses] = useState<
    Record<string, AgUiResumeEntry>
  >({})
  const [projectMedia, setProjectMedia] = useState<ProducerProjectMediaItem[]>([])
  const generationFacts = useProducerGenerationFacts({ sessionId, type: 'session' })
  const initialProjectTitle = useMemo(
    () => normalizeProducerProjectTitle(sessionTitle ?? DEFAULT_PROJECT_TITLE),
    [sessionTitle],
  )
  const [projectTitle, setProjectTitle] = useState(initialProjectTitle)
  const [isPreparingSubmission, setIsPreparingSubmission] = useState(false)
  const businessStateControllerRef = useRef<AbortController | null>(null)
  const postRunMetadataControllerRef = useRef<AbortController | null>(null)
  const generationRecordsRef = useRef<Record<string, unknown>[]>([])
  const lastGenerationRecordsKeyRef = useRef<string | null>(producerGenerationRecordsKey([]))
  const lastWorkspaceWriteResultsRevisionRef = useRef<string | null>(null)
  const runHasWorkspaceWriteRefreshRef = useRef(false)
  const pendingDraftConsumedRef = useRef(false)
  const submissionInFlightRef = useRef(false)
  const threadMessagesRef = useRef<ThreadMessage[]>([])
  const wasThreadRunningRef = useRef(false)
  const workspaceWriteRevision = useMemo(
    () => workspaceWriteResultsRevision({ memberSegments, messages: threadMessages }),
    [memberSegments, threadMessages],
  )

  const activeInterrupt = useMemo<ProjectChatInterrupt | null>(() => {
    const active = pendingAguiInterrupts.find(
      (interrupt) => !pendingInterruptResponses[interrupt.id],
    )

    if (!active) {
      return null
    }

    return interruptFromAgUiInterrupt(active)
  }, [pendingAguiInterrupts, pendingInterruptResponses])

  const activeInterruptRef = useRef<ProjectChatInterrupt | null>(null)
  const connectionPhaseRef = useRef(connectionState.phase)

  useEffect(() => {
    activeInterruptRef.current = activeInterrupt
  }, [activeInterrupt])

  useEffect(() => {
    connectionPhaseRef.current = connectionState.phase
  }, [connectionState.phase])

  useEffect(() => {
    threadMessagesRef.current = [...threadMessages]
  }, [threadMessages])

  useEffect(() => {
    const pendingIds = new Set(pendingAguiInterrupts.map((interrupt) => interrupt.id))

    setPendingInterruptResponses((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([interruptId]) => pendingIds.has(interruptId)),
      )

      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [pendingAguiInterrupts])

  useEffect(() => {
    setProjectTitle(initialProjectTitle)
  }, [initialProjectTitle])

  const setSubmissionInFlight = useCallback((inFlight: boolean) => {
    submissionInFlightRef.current = inFlight
    setIsPreparingSubmission(inFlight)
  }, [])
  const clearProjectErrorMessages = useCallback(() => {
    clearComposerRequestErrorMessage()
    setComposerAttachmentErrorMessage(undefined)
  }, [clearComposerRequestErrorMessage, setComposerAttachmentErrorMessage])
  const applyClassifiedError = useCallback(
    ({ error }: { error: unknown }) => {
      if (isAbortError(error)) {
        return
      }

      const classifiedError = classifyProjectChatError(error)

      if (classifiedError.kind === 'attachment') {
        setComposerAttachmentErrorMessage(classifiedError.message)
      } else {
        setComposerRequestErrorMessage(classifiedError.message)
      }

      requestComposerFocus()
    },
    [requestComposerFocus, setComposerAttachmentErrorMessage, setComposerRequestErrorMessage],
  )
  const isProjectLocalRunActive = useCallback(
    () => submissionInFlightRef.current || threadRuntime.getState().isRunning,
    [threadRuntime],
  )
  const isHydrated = aguiState !== null
  const isInteractionLocked = isPreparingSubmission || threadIsRunning
  const sessionRunObservation = useMemo(
    () =>
      projectSessionRunObservation({
        activeInterrupt,
        isHydrated,
        isRunning: threadIsRunning,
        messages: threadMessages,
      }),
    [activeInterrupt, isHydrated, threadIsRunning, threadMessages],
  )

  /**
   * 拉取业务 state（artifacts/media），不接触 runtime messages 与 interrupt。
   *
   * runtime 消息与中断由 runtime 自己通过 AG-UI 事件流维护；这里只负责
   * 项目业务态（视频生成进度等）。视频轮询、手动提交视频后均走这条路径。
   */
  const refreshProjectBusinessState = useCallback(
    async ({
      generations,
      lazy = false,
    }: {
      generations?: Record<string, unknown>[]
      lazy?: boolean
    } = {}) => {
      businessStateControllerRef.current?.abort()
      const controller = new AbortController()
      businessStateControllerRef.current = controller

      const generationRecords =
        generations === undefined
          ? generationRecordsRef.current
          : mergeProducerGenerationRecords(generationRecordsRef.current, generations)

      generationRecordsRef.current = generationRecords
      try {
        const business = await fetchProjectBusinessState({
          generations: generationRecords,
          sessionId,
          signal: controller.signal,
        })
        throwIfSignalAborted(controller.signal)
        generationRecordsRef.current = business.generations
        const apply = () => {
          setAssets((current) => preserveEqualSerializableValue(current, business.assets))
          setPersistedArtifacts((current) =>
            preserveEqualSerializableValue(current, business.artifacts),
          )
          setGenerationRecords((current) =>
            preserveEqualSerializableValue(current, business.generations),
          )
          setProjectMedia((current) => preserveEqualSerializableValue(current, business.media))
        }

        if (lazy) {
          startTransition(apply)
        } else {
          apply()
        }
      } catch (error) {
        if (!isAbortError(error)) {
          throw error
        }
      } finally {
        if (businessStateControllerRef.current === controller) {
          businessStateControllerRef.current = null
        }
      }
    },
    [sessionId],
  )

  const refreshProducerProjectMetadata = useCallback(
    async ({ lazy = false, signal }: { lazy?: boolean; signal?: AbortSignal } = {}) => {
      throwIfSignalAborted(signal)
      const project = await getProducerProjectSession(projectId, sessionId, { signal })
      throwIfSignalAborted(signal)
      const applyProject = () => {
        setProjectTitle(normalizeProducerProjectTitle(project.title))
      }

      if (lazy) {
        startTransition(applyProject)
        return project
      }

      applyProject()

      return project
    },
    [projectId, sessionId],
  )

  // Mount: 重置本地运行态。历史消息来自 restore；业务详情随后从持久化接口水合。
  useEffect(() => {
    businessStateControllerRef.current?.abort()
    businessStateControllerRef.current = null
    postRunMetadataControllerRef.current?.abort()
    postRunMetadataControllerRef.current = null
    clearProjectErrorMessages()
    setSubmissionInFlight(false)
    setAssets([])
    setGenerationRecords([])
    setPersistedArtifacts([])
    setProjectMedia([])
    generationRecordsRef.current = []
    lastGenerationRecordsKeyRef.current = producerGenerationRecordsKey([])
    lastWorkspaceWriteResultsRevisionRef.current = null
    runHasWorkspaceWriteRefreshRef.current = false
    threadMessagesRef.current = []

    return () => {
      businessStateControllerRef.current?.abort()
      postRunMetadataControllerRef.current?.abort()
    }
  }, [clearProjectErrorMessages, setSubmissionInFlight])

  useEffect(() => {
    if (!generationFacts.error) {
      return
    }

    applyClassifiedError({
      error: generationFacts.error,
    })
  }, [applyClassifiedError, generationFacts.error])

  useEffect(() => {
    const nextGenerationRecordsKey = producerGenerationRecordsKey(generationFacts.generations)

    if (lastGenerationRecordsKeyRef.current === nextGenerationRecordsKey) {
      return
    }

    lastGenerationRecordsKeyRef.current = nextGenerationRecordsKey
    const generationRecords = mergeProducerGenerationRecords(
      generationRecordsRef.current,
      generationFacts.generations,
    )
    generationRecordsRef.current = generationRecords
    setGenerationRecords((current) => preserveEqualSerializableValue(current, generationRecords))

    if (!isHydrated) {
      return
    }

    void refreshProjectBusinessState({
      generations: generationRecords,
      lazy: true,
    }).catch((error) => {
      applyClassifiedError({
        error,
      })
    })
  }, [applyClassifiedError, generationFacts.generations, isHydrated, refreshProjectBusinessState])

  // restore 完成后从持久化业务接口水合；AG-UI state 内容不承担业务索引职责。
  useEffect(() => {
    if (!isHydrated) {
      return
    }

    void refreshProjectBusinessState({ lazy: true }).catch((error) => {
      applyClassifiedError({ error })
    })
  }, [applyClassifiedError, isHydrated, refreshProjectBusinessState])

  // 写入工具结果中的 path 只触发重读；画布正文始终来自 Workspace API。
  useEffect(() => {
    if (!isHydrated) {
      return
    }

    if (lastWorkspaceWriteResultsRevisionRef.current === null) {
      lastWorkspaceWriteResultsRevisionRef.current = workspaceWriteRevision
      return
    }

    if (lastWorkspaceWriteResultsRevisionRef.current === workspaceWriteRevision) {
      return
    }

    lastWorkspaceWriteResultsRevisionRef.current = workspaceWriteRevision

    // 同一批事件已经进入终态时，由下面的终态 effect 做一次收敛重读。
    if (!threadIsRunning) {
      return
    }

    runHasWorkspaceWriteRefreshRef.current = true
    void refreshProjectBusinessState({ lazy: true }).catch((error) => {
      applyClassifiedError({ error })
    })
  }, [
    applyClassifiedError,
    isHydrated,
    refreshProjectBusinessState,
    threadIsRunning,
    workspaceWriteRevision,
  ])

  // React to runtime errors
  useEffect(() => {
    if (!runtimeError) {
      return
    }

    applyClassifiedError({
      error: runtimeError,
    })
    clearRuntimeError()
  }, [applyClassifiedError, clearRuntimeError, runtimeError])

  useEffect(() => {
    if (!sessionRunObservation.errorMessage) {
      return
    }

    applyClassifiedError({
      error: new Error(sessionRunObservation.errorMessage),
    })
  }, [applyClassifiedError, sessionRunObservation.errorMessage])

  // 未被写入结果刷新覆盖的 run 在终态收敛业务事实；成功完成时再刷新 session metadata。
  useEffect(() => {
    if (threadIsRunning) {
      if (!wasThreadRunningRef.current) {
        runHasWorkspaceWriteRefreshRef.current = false
      }
      wasThreadRunningRef.current = true
      return
    }

    if (!wasThreadRunningRef.current) {
      return
    }

    wasThreadRunningRef.current = false

    if (!runHasWorkspaceWriteRefreshRef.current) {
      void refreshProjectBusinessState({ lazy: true }).catch((error) => {
        applyClassifiedError({ error })
      })
    }
    runHasWorkspaceWriteRefreshRef.current = false

    if (sessionRunObservation.status !== 'COMPLETED') {
      return
    }

    postRunMetadataControllerRef.current?.abort()
    const metadataController = new AbortController()
    postRunMetadataControllerRef.current = metadataController
    void refreshProducerProjectMetadata({
      lazy: true,
      signal: metadataController.signal,
    })
      .catch((error) => {
        if (!isAbortError(error)) {
          applyClassifiedError({
            error,
          })
        }
      })
      .finally(() => {
        if (postRunMetadataControllerRef.current === metadataController) {
          postRunMetadataControllerRef.current = null
        }
      })
  }, [
    applyClassifiedError,
    refreshProjectBusinessState,
    refreshProducerProjectMetadata,
    sessionRunObservation.status,
    threadIsRunning,
  ])

  const timelineItems = useMemo(
    () =>
      projectConversationTimelineItemsFromAssistantMessages({
        activeInterrupt,
        isRunning: threadIsRunning,
        memberSegments,
        messages: threadMessages,
      }),
    [activeInterrupt, memberSegments, threadIsRunning, threadMessages],
  )

  const artifacts = persistedArtifacts

  const runDraftSubmission = useCallback(
    async ({ draft, message }: { draft: MediaComposerDraft; message: MediaComposerMessage }) => {
      if (submissionInFlightRef.current || composerStore.getState().pendingUploadCount > 0) {
        return
      }

      if (activeInterruptRef.current) {
        setComposerRequestErrorMessage(WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE)
        requestComposerFocus()
        return
      }

      if (isProjectLocalRunActive()) {
        setComposerRequestErrorMessage('当前 Agent 正在运行，请等待完成后再发送。')
        requestComposerFocus()
        return
      }

      // 重连期间禁写是「永不静默吞消息」的第一道防线（第二道是服务端
      // RUN_IN_PROGRESS 显式拒绝，ADR-0005）。
      if (
        connectionPhaseRef.current === 'interrupted' ||
        connectionPhaseRef.current === 'degraded'
      ) {
        setComposerRequestErrorMessage('连接已中断，正在恢复，请稍后再发送。')
        requestComposerFocus()
        return
      }

      clearProjectErrorMessages()
      const originalMessages = [...threadMessagesRef.current]
      let shouldRestoreThread = false
      clearComposerDraftForSubmit()
      setSubmissionInFlight(true)

      try {
        const preparedParts = await prepareComposerMessagePartsForSubmission(message.parts)
        postRunMetadataControllerRef.current?.abort()
        postRunMetadataControllerRef.current = null

        shouldRestoreThread = true
        threadRuntime.append(
          createProjectAssistantUserMessage({
            parts: preparedParts,
          }),
        )
        completeComposerDraftSubmission()
      } catch (error) {
        if (shouldRestoreThread) {
          threadRuntime.reset(originalMessages)
        }

        restoreComposerDraft(draft)
        applyClassifiedError({
          error,
        })
      } finally {
        setSubmissionInFlight(false)
      }
    },
    [
      applyClassifiedError,
      clearComposerDraftForSubmit,
      clearProjectErrorMessages,
      completeComposerDraftSubmission,
      composerStore,
      isProjectLocalRunActive,
      requestComposerFocus,
      restoreComposerDraft,
      setComposerRequestErrorMessage,
      setSubmissionInFlight,
      threadRuntime,
    ],
  )

  const submitDraft = useCallback(
    async (draft: MediaComposerDraft) => {
      let message: MediaComposerMessage

      try {
        message = createMediaComposerMessage({
          draft,
          libraryMedia: projectMedia.map(producerProjectMediaToMediaComposerLibraryMedia),
        })
      } catch (error) {
        clearProjectErrorMessages()
        applyClassifiedError({ error })
        return
      }

      await runDraftSubmission({ draft, message })
    },
    [applyClassifiedError, clearProjectErrorMessages, projectMedia, runDraftSubmission],
  )

  useEffect(() => {
    if (
      pendingDraftConsumedRef.current ||
      aguiState === null ||
      !composerDraftIsEmpty ||
      pendingComposerUploadCount > 0 ||
      isProjectLocalRunActive()
    ) {
      return
    }

    if (activeInterruptRef.current) {
      return
    }

    const composerState = composerStore.getState()

    if (composerState.pendingUploadCount > 0 || !isMediaComposerDraftEmpty(composerState)) {
      return
    }

    let pendingDraft

    try {
      pendingDraft = consumeProjectPendingDraft(projectId, sessionId)
    } catch (error) {
      pendingDraftConsumedRef.current = true
      applyClassifiedError({ error })
      return
    }

    if (!pendingDraft) {
      return
    }

    pendingDraftConsumedRef.current = true
    void runDraftSubmission(pendingDraft)
  }, [
    aguiState,
    applyClassifiedError,
    composerDraftIsEmpty,
    composerStore,
    isProjectLocalRunActive,
    pendingComposerUploadCount,
    projectId,
    sessionId,
    runDraftSubmission,
  ])

  const { submitAskUserQuestionOutput } = useProjectInterruptActions({
    applyClassifiedError,
    clearProjectErrorMessages,
    pendingInterruptResponses,
    setPendingInterruptResponses,
  })

  const { saveVideoPrompt, submitVideoGeneration, submitVideoGenerations } =
    useProjectVideoGenerationActions({
      activeInterruptRef,
      clearProjectErrorMessages,
      isProjectLocalRunActive,
      postRunMetadataControllerRef,
      refreshProjectBusinessState,
      sessionId,
    })

  useEffect(
    () => () => {
      postRunMetadataControllerRef.current?.abort()
    },
    [],
  )

  const activityValue = useMemo<ProjectChatActivityContextValue>(
    () => ({
      isInteractionLocked,
      sessionRunStatus: sessionRunObservation.status,
    }),
    [isInteractionLocked, sessionRunObservation.status],
  )

  const resourcesValue = useMemo<ProjectChatResourcesContextValue>(
    () => ({
      artifacts,
      assets,
      generationRecords,
      projectMedia,
    }),
    [artifacts, assets, generationRecords, projectMedia],
  )
  const videoGenerationValue = useMemo<ProjectChatVideoGenerationContextValue>(
    () => ({
      isInteractionLocked,
      saveVideoPrompt,
      submitVideoGenerations,
      submitVideoGeneration,
    }),
    [isInteractionLocked, saveVideoPrompt, submitVideoGenerations, submitVideoGeneration],
  )
  const askUserQuestionValue = useMemo<ProjectChatAskUserQuestionContextValue>(
    () => ({
      isInteractionLocked,
      submitAskUserQuestionOutput,
    }),
    [isInteractionLocked, submitAskUserQuestionOutput],
  )
  const composerValue = useMemo<ProjectChatComposerContextValue>(
    () => ({
      activeInterrupt,
      isInteractionLocked,
      projectMedia,
      submitDraft,
    }),
    [activeInterrupt, isInteractionLocked, projectMedia, submitDraft],
  )
  const conversationValue = useMemo<ProjectChatConversationContextValue>(
    () => ({
      activeInterrupt,
      projectMedia,
      timelineItems,
    }),
    [activeInterrupt, projectMedia, timelineItems],
  )

  return (
    <ProjectChatActivityContext.Provider value={activityValue}>
      <ProjectChatTitleContext.Provider value={projectTitle}>
        <ProjectChatActiveInterruptContext.Provider value={activeInterrupt}>
          <ProjectChatResourcesContext.Provider value={resourcesValue}>
            <ProjectChatVideoGenerationContext.Provider value={videoGenerationValue}>
              <ProjectChatAskUserQuestionContext.Provider value={askUserQuestionValue}>
                <ProjectChatComposerContext.Provider value={composerValue}>
                  <ProjectChatConversationContext.Provider value={conversationValue}>
                    {children}
                  </ProjectChatConversationContext.Provider>
                </ProjectChatComposerContext.Provider>
              </ProjectChatAskUserQuestionContext.Provider>
            </ProjectChatVideoGenerationContext.Provider>
          </ProjectChatResourcesContext.Provider>
        </ProjectChatActiveInterruptContext.Provider>
      </ProjectChatTitleContext.Provider>
    </ProjectChatActivityContext.Provider>
  )
}
