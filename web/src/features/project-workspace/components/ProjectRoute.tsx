import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AgentOSSessionStatus,
  createProjectComposerStore,
  fetchAgentOSRuns,
  ProjectChatProvider,
  ProjectComposerStoreProvider,
  sessionStatusFromAgentOSRuns,
  useProjectChatActivity,
  useProjectChatResources,
  useProjectChatTitle,
} from '@/features/chat'
import { useProjectCanvasStore } from '@/features/project-canvas'
import CanvasVideoWorkspace from '@/features/project-workspace/components/CanvasVideoWorkspace'
import ProjectDesktopShell from '@/features/project-workspace/components/ProjectDesktopShell'
import ProjectHeaderLeft from '@/features/project-workspace/components/ProjectHeaderLeft'
import ProjectHeaderRight from '@/features/project-workspace/components/ProjectHeaderRight'
import ProjectMobileShell from '@/features/project-workspace/components/ProjectMobileShell'
import ProjectMouseGlow from '@/features/project-workspace/components/ProjectMouseGlow'
import { ProjectWorkspaceProviders } from '@/features/project-workspace/components/ProjectPageProviders'
import ProjectSessionTabs, {
  type ProjectSessionTabIndicator,
} from '@/features/project-workspace/components/ProjectSessionTabs'
import {
  addRecentProjectSessionId,
  projectSessionIndicatorsForTabs,
  projectSessionsWithSubscribedRuntimes,
  pruneProjectSessionIds,
  pruneProjectSessionRunStatuses,
} from '@/features/project-workspace/utils/project-session-subscriptions'
import {
  createProducerProjectSession,
  getProducerProject,
  listProducerProjectSessions,
  listProducerSessionGenerations,
  type ProducerProject,
  type ProducerProjectSession,
  hasActiveProducerGenerations,
  readPreferredProducerProjectSessionId,
  storePreferredProducerProjectSessionId,
} from '@/features/projects'
import { useBreakpoint } from '@/shared/hooks/useBreakpoint'
import useHasMounted from '@/shared/hooks/useHasMounted'
import RouteBootShell from '@/shared/ui/RouteBootShell'

interface ProjectRouteProps {
  projectId: string
}

interface ProjectSessionTitleSyncBridgeProps {
  onSessionTitleChange: (sessionId: string, title: string) => void
  sessionId: string
}

interface ProjectSessionRunStatusSyncBridgeProps {
  onSessionRunStatusChange: (sessionId: string, status: AgentOSSessionStatus) => void
  sessionId: string
}

interface ProjectSessionGenerationActivitySyncBridgeProps {
  onSessionGenerationActivityChange: (sessionId: string, active: boolean) => void
  sessionId: string
}

interface ProjectErrorStateProps {
  message: string
}

interface ProjectSessionRuntimeHostProps {
  children?: ReactNode
  onSessionGenerationActivityChange: (sessionId: string, active: boolean) => void
  onSessionRunStatusChange: (sessionId: string, status: AgentOSSessionStatus) => void
  onSessionTitleChange: (sessionId: string, title: string) => void
  projectId: string
  sessionId: string
  sessionTitle: string
}

interface ProjectActiveSessionWorkspaceProps {
  activeSessionId: string
  isDesktop: boolean
  onSessionSelect: (sessionId: string) => void
  onSessionsChange: (updatedSessions: ProducerProjectSession[]) => void
  projectId: string
  sessionIndicators: Record<string, ProjectSessionTabIndicator>
  sessions: ProducerProjectSession[]
}

interface ProjectSessionActivityState {
  activeGenerationSessionIds: string[]
  runStatuses: Record<string, AgentOSSessionStatus>
  unreadSessionIds: string[]
}

const EMPTY_PROJECT_SESSION_ACTIVITY: ProjectSessionActivityState = {
  activeGenerationSessionIds: [],
  runStatuses: {},
  unreadSessionIds: [],
}

const ACTIVE_AGENT_RUN_STATUSES = new Set<AgentOSSessionStatus>(['PENDING', 'RUNNING', 'PAUSED'])

const addSessionId = (sessionIds: string[], sessionId: string) =>
  sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId]

/**
 * 将聊天上下文中的业务资源同步给 focused artifact 面板。
 *
 * Agent 页不再把这些节点渲染进 React Flow；资源仍保留在 project-canvas store，
 * 供左侧产物预览、书签和媒体状态读取。
 *
 * @returns 无可见 UI，仅负责跨 store 状态同步。
 */
function ProjectCanvasResourceSyncBridge() {
  const { artifacts, projectMedia } = useProjectChatResources()
  const syncArtifacts = useProjectCanvasStore((state) => state.syncArtifacts)
  const syncProjectMedia = useProjectCanvasStore((state) => state.syncProjectMedia)

  useEffect(() => {
    syncArtifacts(artifacts)
  }, [artifacts, syncArtifacts])

  useEffect(() => {
    syncProjectMedia(projectMedia)
  }, [projectMedia, syncProjectMedia])

  return null
}

/**
 * 将聊天上下文中已刷新的 session 标题同步回顶部 session tabs。
 *
 * @param props - 标题同步属性。
 * @param props.onSessionTitleChange - 标题变化回调。
 * @param props.sessionId - 当前 Agno session id。
 * @returns 无可见 UI，仅负责状态同步。
 */
function ProjectSessionTitleSyncBridge({
  onSessionTitleChange,
  sessionId,
}: ProjectSessionTitleSyncBridgeProps) {
  const title = useProjectChatTitle()

  useEffect(() => {
    onSessionTitleChange(sessionId, title)
  }, [onSessionTitleChange, sessionId, title])

  return null
}

/**
 * 将当前 chat runtime 的官方 run 状态同步到项目会话层。
 *
 * @param props - session run 状态同步属性。
 * @param props.onSessionRunStatusChange - 官方 run 状态变化回调。
 * @param props.sessionId - 当前 Agno session id。
 * @returns 无可见 UI，仅负责 run 状态同步。
 */
function ProjectSessionRunStatusSyncBridge({
  onSessionRunStatusChange,
  sessionId,
}: ProjectSessionRunStatusSyncBridgeProps) {
  const { sessionRunStatus } = useProjectChatActivity()
  const hasReportedActiveRef = useRef(false)

  useEffect(() => {
    if (sessionRunStatus === null) {
      return
    }

    // 订阅不变量（state-management.md）：runtime 先上报过 running/hitl 后，
    // 本地非运行观察才能覆盖后端运行摘要。注水完成到 attach 起跑之间的
    // 终态观察不得抢先驱逐后端标记为 running 的 session。
    if (ACTIVE_AGENT_RUN_STATUSES.has(sessionRunStatus)) {
      hasReportedActiveRef.current = true
    } else if (!hasReportedActiveRef.current) {
      return
    }

    onSessionRunStatusChange(sessionId, sessionRunStatus)
  }, [onSessionRunStatusChange, sessionId, sessionRunStatus])

  return null
}

/** 将当前 session 是否存在活跃视频生成同步到项目会话层。 */
function ProjectSessionGenerationActivitySyncBridge({
  onSessionGenerationActivityChange,
  sessionId,
}: ProjectSessionGenerationActivitySyncBridgeProps) {
  const { generationRecords } = useProjectChatResources()

  useEffect(() => {
    if (generationRecords.length === 0) {
      return
    }

    onSessionGenerationActivityChange(sessionId, hasActiveProducerGenerations(generationRecords))
  }, [generationRecords, onSessionGenerationActivityChange, sessionId])

  return null
}

/**
 * 常驻单个 session 的聊天 runtime，切换项目 session 时不卸载正在运行的 AG-UI 流。
 *
 * @param props - runtime host 属性。
 * @param props.children - 当前 active session 才会渲染的工作区 UI。
 * @param props.onSessionGenerationActivityChange - 视频生成活动变化回调。
 * @param props.onSessionRunStatusChange - 官方 run 状态变化回调。
 * @param props.onSessionTitleChange - session 标题变化回调。
 * @param props.projectId - 当前项目文件夹 id。
 * @param props.sessionId - 当前 Agno session id。
 * @param props.sessionTitle - 当前 session 标题。
 * @returns 常驻 session runtime host。
 */
function ProjectSessionRuntimeHost({
  children,
  onSessionGenerationActivityChange,
  onSessionRunStatusChange,
  onSessionTitleChange,
  projectId,
  sessionId,
  sessionTitle,
}: ProjectSessionRuntimeHostProps) {
  const composerStore = useMemo(() => createProjectComposerStore(), [])

  return (
    <ProjectComposerStoreProvider store={composerStore}>
      <ProjectChatProvider projectId={projectId} sessionId={sessionId} sessionTitle={sessionTitle}>
        <ProjectSessionTitleSyncBridge
          sessionId={sessionId}
          onSessionTitleChange={onSessionTitleChange}
        />
        <ProjectSessionRunStatusSyncBridge
          sessionId={sessionId}
          onSessionRunStatusChange={onSessionRunStatusChange}
        />
        <ProjectSessionGenerationActivitySyncBridge
          sessionId={sessionId}
          onSessionGenerationActivityChange={onSessionGenerationActivityChange}
        />
        {children}
      </ProjectChatProvider>
    </ProjectComposerStoreProvider>
  )
}

/**
 * 渲染当前 active session 的可见项目工作区。
 *
 * @param props - active 工作区属性。
 * @param props.activeSessionId - 当前激活的 session id。
 * @param props.isDesktop - 是否渲染桌面工作区。
 * @param props.onSessionSelect - 顶部 session 选择回调。
 * @param props.onSessionsChange - 顶部 session 列表变化回调。
 * @param props.projectId - 当前项目文件夹 id。
 * @param props.sessionIndicators - 顶部 session 状态符号。
 * @param props.sessions - 当前项目文件夹下的 session 列表。
 * @returns 当前 session 的项目页 UI。
 */
function ProjectActiveSessionWorkspace({
  activeSessionId,
  isDesktop,
  onSessionSelect,
  onSessionsChange,
  projectId,
  sessionIndicators,
  sessions,
}: ProjectActiveSessionWorkspaceProps) {
  return (
    <ProjectWorkspaceProviders projectId={activeSessionId}>
      <div className="project-workspace relative h-svh max-h-svh overflow-hidden">
        <ProjectMouseGlow />

        <header className="layer-header pointer-events-auto absolute inset-x-0 top-0">
          <div className="relative flex h-[var(--layout-project-header-height)] w-full items-center justify-between text-[var(--color-on-background)]">
            <div className="relative flex h-full w-full items-center justify-between gap-4 bg-transparent pt-4 pr-[var(--layout-project-header-inline-end)] pb-4 pl-[var(--layout-project-header-inline-start)]">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <ProjectHeaderLeft />
                {isDesktop && sessions.length > 0 && (
                  <>
                    <div className="h-4 w-px shrink-0 bg-[var(--color-border)] opacity-40" />
                    <div className="min-w-0 flex-1">
                      <ProjectSessionTabs
                        projectId={projectId}
                        sessionId={activeSessionId}
                        sessionIndicators={sessionIndicators}
                        sessions={sessions}
                        onSessionsChange={onSessionsChange}
                        onSessionSelect={onSessionSelect}
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <ProjectHeaderRight />
              </div>
            </div>
          </div>
        </header>

        <ProjectCanvasResourceSyncBridge />
        <main className="absolute inset-0 flex overflow-hidden">
          <div className="min-w-0 flex-1">
            {isDesktop ? <ProjectDesktopShell /> : <ProjectMobileShell />}
          </div>
        </main>
      </div>
    </ProjectWorkspaceProviders>
  )
}

/**
 * 渲染 Agent 项目的 session 工作台路由。
 *
 * @param props - 项目路由属性。
 * @param props.projectId - 当前项目文件夹 id。
 * @returns 桌面或移动端 Agent 项目工作台。
 */
function ProjectAgentRoute({ projectId }: ProjectRouteProps) {
  const hasMounted = useHasMounted()
  const isDesktop = useBreakpoint('md')
  const [activeSessionId, setActiveSessionId] = useState<null | string>(null)
  const [isSessionListReady, setIsSessionListReady] = useState(false)
  const [projectSessionActivity, setProjectSessionActivity] = useState<ProjectSessionActivityState>(
    EMPTY_PROJECT_SESSION_ACTIVITY,
  )
  const [recentSessionIds, setRecentSessionIds] = useState<string[]>([])
  const [sessionLoadErrorMessage, setSessionLoadErrorMessage] = useState<null | string>(null)
  const [sessionStatusErrorMessage, setSessionStatusErrorMessage] = useState<null | string>(null)
  const [sessions, setSessions] = useState<ProducerProjectSession[]>([])
  const sessionIdsKey = useMemo(() => sessions.map((session) => session.id).join('\n'), [sessions])
  const effectiveSessionIndicators = useMemo(
    () =>
      projectSessionIndicatorsForTabs({
        activeGenerationSessionIds: projectSessionActivity.activeGenerationSessionIds,
        sessionRunStatuses: projectSessionActivity.runStatuses,
        sessions,
        unreadSessionIds: projectSessionActivity.unreadSessionIds,
      }),
    [projectSessionActivity, sessions],
  )
  const subscribedSessions = useMemo(
    () =>
      projectSessionsWithSubscribedRuntimes({
        activeGenerationSessionIds: projectSessionActivity.activeGenerationSessionIds,
        activeSessionId,
        recentSessionIds,
        sessionRunStatuses: projectSessionActivity.runStatuses,
        sessions,
      }),
    [activeSessionId, projectSessionActivity, recentSessionIds, sessions],
  )

  /**
   * 将指定 session 标记为用户已经查看。
   *
   * @param targetSessionId - 需要清除未读状态的 session id。
   * @returns 无返回值。
   */
  const markSessionReviewed = useCallback((targetSessionId: string) => {
    setProjectSessionActivity((current) => {
      if (!current.unreadSessionIds.includes(targetSessionId)) {
        return current
      }

      return {
        ...current,
        unreadSessionIds: current.unreadSessionIds.filter(
          (sessionId) => sessionId !== targetSessionId,
        ),
      }
    })
  }, [])

  /**
   * 选择当前项目页正在打开的 session。
   *
   * @param nextSessionId - 需要激活的 Agno session id。
   * @returns 无返回值。
   */
  const selectActiveSession = useCallback(
    (nextSessionId: string) => {
      markSessionReviewed(nextSessionId)
      setActiveSessionId(nextSessionId)
      storePreferredProducerProjectSessionId(projectId, nextSessionId)
    },
    [markSessionReviewed, projectId],
  )

  /**
   * 应用后端 session 列表，并从浏览器会话记录里恢复当前 active session。
   *
   * @param nextSessions - 后端返回的项目 session 列表。
   * @returns 无返回值。
   */
  const applyProjectSessions = useCallback(
    (nextSessions: ProducerProjectSession[]) => {
      setSessions(nextSessions)
      setRecentSessionIds((currentSessionIds) =>
        pruneProjectSessionIds(currentSessionIds, nextSessions),
      )
      setProjectSessionActivity((current) => ({
        activeGenerationSessionIds: pruneProjectSessionIds(
          current.activeGenerationSessionIds,
          nextSessions,
        ),
        runStatuses: pruneProjectSessionRunStatuses(current.runStatuses, nextSessions),
        unreadSessionIds: pruneProjectSessionIds(current.unreadSessionIds, nextSessions),
      }))
      setActiveSessionId((currentSessionId) => {
        if (currentSessionId && nextSessions.some((session) => session.id === currentSessionId)) {
          return currentSessionId
        }

        const preferredSessionId = readPreferredProducerProjectSessionId(projectId)
        const nextSessionId =
          nextSessions.find((session) => session.id === preferredSessionId)?.id ??
          nextSessions[0]?.id ??
          null

        if (nextSessionId) {
          storePreferredProducerProjectSessionId(projectId, nextSessionId)
        }

        return nextSessionId
      })
    },
    [projectId],
  )

  /**
   * 将当前 session 的最新标题写回路由层 session 列表。
   *
   * @param targetSessionId - 需要更新标题的 session id。
   * @param title - 后端自动命名或手动刷新后的 session 标题。
   * @returns 无返回值。
   */
  const syncSessionTitle = useCallback((targetSessionId: string, title: string) => {
    const nextTitle = title.trim()

    if (!nextTitle) {
      return
    }

    setSessions((currentSessions) => {
      let hasChanged = false
      const nextSessions = currentSessions.map((session) => {
        if (session.id !== targetSessionId || session.title === nextTitle) {
          return session
        }

        hasChanged = true
        return { ...session, title: nextTitle }
      })

      return hasChanged ? nextSessions : currentSessions
    })
  }, [])

  /** 将已挂载 runtime 的官方 run 状态同步到项目层。 */
  const syncSessionRunStatus = useCallback(
    (targetSessionId: string, status: AgentOSSessionStatus) => {
      setProjectSessionActivity((current) => {
        const currentStatus = current.runStatuses[targetSessionId] ?? 'COMPLETED'
        const shouldMarkUnread =
          targetSessionId !== activeSessionId &&
          status === 'COMPLETED' &&
          ACTIVE_AGENT_RUN_STATUSES.has(currentStatus)
        const unreadSessionIds = shouldMarkUnread
          ? addSessionId(current.unreadSessionIds, targetSessionId)
          : current.unreadSessionIds

        if (currentStatus === status && unreadSessionIds === current.unreadSessionIds) {
          return current
        }

        return {
          ...current,
          runStatuses: { ...current.runStatuses, [targetSessionId]: status },
          unreadSessionIds,
        }
      })
    },
    [activeSessionId],
  )

  /** 将 session 视频生成活动与 Agent run 状态分开同步。 */
  const syncSessionGenerationActivity = useCallback(
    (targetSessionId: string, active: boolean) => {
      setProjectSessionActivity((current) => {
        const wasActive = current.activeGenerationSessionIds.includes(targetSessionId)

        if (wasActive === active) {
          return current
        }

        return {
          ...current,
          activeGenerationSessionIds: active
            ? [...current.activeGenerationSessionIds, targetSessionId]
            : current.activeGenerationSessionIds.filter(
                (sessionId) => sessionId !== targetSessionId,
              ),
          unreadSessionIds:
            wasActive && !active && targetSessionId !== activeSessionId
              ? addSessionId(current.unreadSessionIds, targetSessionId)
              : current.unreadSessionIds,
        }
      })
    },
    [activeSessionId],
  )

  useEffect(() => {
    if (!sessionIdsKey || !activeSessionId) {
      setSessionStatusErrorMessage(null)
      return
    }

    const controller = new AbortController()
    const sessionIds = sessionIdsKey.split('\n')

    setSessionStatusErrorMessage(null)
    void Promise.all(
      sessionIds.map(async (sessionId) => {
        const [runs, generations] = await Promise.all([
          fetchAgentOSRuns(sessionId, { signal: controller.signal }),
          listProducerSessionGenerations(sessionId, { signal: controller.signal }),
        ])

        return [
          sessionId,
          sessionStatusFromAgentOSRuns(runs),
          hasActiveProducerGenerations(generations),
        ] as const
      }),
    )
      .then((entries) => {
        if (controller.signal.aborted) {
          return
        }

        for (const [sessionId, runStatus, generationActive] of entries) {
          syncSessionGenerationActivity(sessionId, generationActive)
          syncSessionRunStatus(sessionId, runStatus)
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return
        }

        setSessionStatusErrorMessage(
          error instanceof Error ? error.message : '加载 session 状态失败',
        )
      })

    return () => {
      controller.abort()
    }
  }, [activeSessionId, sessionIdsKey, syncSessionGenerationActivity, syncSessionRunStatus])

  // 统一在路由层获取当前项目文件夹下的完整 session 列表，传递给顶部胶囊 Tab。
  useEffect(() => {
    const controller = new AbortController()

    setActiveSessionId(null)
    setIsSessionListReady(false)
    setProjectSessionActivity(EMPTY_PROJECT_SESSION_ACTIVITY)
    setRecentSessionIds([])
    setSessionLoadErrorMessage(null)
    setSessionStatusErrorMessage(null)
    setSessions([])

    const loadProjectSessions = async () => {
      try {
        const loadedSessions = await listProducerProjectSessions(projectId, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) {
          return
        }

        if (loadedSessions.length > 0) {
          applyProjectSessions(loadedSessions)
          return
        }

        const firstSession = await createProducerProjectSession(projectId, {
          signal: controller.signal,
        })

        if (controller.signal.aborted) {
          return
        }

        applyProjectSessions([firstSession])
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return
        }

        setSessions([])
        setActiveSessionId(null)
        setSessionLoadErrorMessage(error instanceof Error ? error.message : '加载对话失败')
      } finally {
        if (!controller.signal.aborted) {
          setIsSessionListReady(true)
        }
      }
    }

    void loadProjectSessions()

    return () => {
      controller.abort()
    }
  }, [applyProjectSessions, projectId])

  useEffect(() => {
    if (!activeSessionId) {
      return
    }

    setRecentSessionIds((currentSessionIds) =>
      addRecentProjectSessionId(currentSessionIds, activeSessionId),
    )
  }, [activeSessionId])

  if (!hasMounted || !isSessionListReady) {
    return <RouteBootShell variant="project" />
  }

  const sessionErrorMessage = sessionLoadErrorMessage ?? sessionStatusErrorMessage

  if (sessionErrorMessage) {
    return <ProjectErrorState message={sessionErrorMessage} />
  }

  if (!activeSessionId) {
    return <ProjectErrorState message="项目没有可用对话" />
  }

  return subscribedSessions.map((session) => {
    const isActive = session.id === activeSessionId

    return (
      <ProjectSessionRuntimeHost
        key={session.id}
        projectId={projectId}
        sessionId={session.id}
        sessionTitle={session.title}
        onSessionGenerationActivityChange={syncSessionGenerationActivity}
        onSessionRunStatusChange={syncSessionRunStatus}
        onSessionTitleChange={syncSessionTitle}
      >
        {isActive ? (
          <ProjectActiveSessionWorkspace
            activeSessionId={activeSessionId}
            isDesktop={isDesktop}
            projectId={projectId}
            sessionIndicators={effectiveSessionIndicators}
            sessions={sessions}
            onSessionsChange={applyProjectSessions}
            onSessionSelect={selectActiveSession}
          />
        ) : null}
      </ProjectSessionRuntimeHost>
    )
  })
}

/**
 * 渲染项目工作台路由，并按项目 kind 分流到 Agent 或 Direct Canvas。
 *
 * @param props - 项目路由属性。
 * @param props.projectId - 当前项目文件夹 id。
 * @returns 对应项目类型的工作台。
 */
export default function ProjectRoute({ projectId }: ProjectRouteProps) {
  const hasMounted = useHasMounted()
  const [errorMessage, setErrorMessage] = useState<null | string>(null)
  const [project, setProject] = useState<ProducerProject | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    setErrorMessage(null)
    setProject(null)

    void getProducerProject(projectId, { signal: controller.signal })
      .then(setProject)
      .catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }

        setErrorMessage(error instanceof Error ? error.message : '加载项目失败')
      })

    return () => {
      controller.abort()
    }
  }, [projectId])

  if (!hasMounted || (!project && !errorMessage)) {
    return <RouteBootShell variant="project" />
  }

  if (errorMessage) {
    return <ProjectErrorState message={errorMessage} />
  }

  if (project?.kind === 'direct') {
    return <CanvasVideoWorkspace projectId={project.id} />
  }

  return <ProjectAgentRoute projectId={project?.id ?? projectId} />
}

/**
 * 渲染项目加载错误状态。
 *
 * @param props - 错误状态属性。
 * @param props.message - 项目加载失败错误文案。
 * @returns 项目错误态。
 */
function ProjectErrorState({ message }: ProjectErrorStateProps) {
  return (
    <main className="project-workspace flex min-h-svh items-center justify-center px-6 text-[var(--color-on-background)]">
      <div
        className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-6 py-5 text-center text-[var(--color-danger-text)]"
        role="alert"
      >
        <p className="text-body font-semibold">项目加载失败</p>
        <p className="text-body-sm leading-6">{message}</p>
      </div>
    </main>
  )
}
