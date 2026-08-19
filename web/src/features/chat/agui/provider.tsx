import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ProjectMemberSegment } from '@/features/chat/contracts'
import AguiSessionRuntimeProvider, {
  type AguiCustomEventPayload,
  type AguiRestoreHistory,
  useAguiConnection,
} from '@/shared/agui/provider'
import { PRODUCER_AGUI_TARGET } from '@/shared/config/agui-target'
import {
  AGUI_MEMBER_EVENT_NAME,
  applyProjectMemberEvent,
  createProjectMemberSegmentsState,
  loadProjectMemberSegmentsFromRestore,
  parseProjectMemberEventValue,
  projectMemberSegmentsSnapshot,
} from '../runtime/project-member-segments'
import { loadProjectRestoreHistory } from './history'

export const AGUI_RUN_ENDPOINT = PRODUCER_AGUI_TARGET.apiPrefix

interface ProjectAssistantRuntimeProviderProps {
  children: ReactNode
  onRuntimeError: (error: Error) => void
  sessionId: string
}

const ProjectMemberSegmentsContext = createContext<ProjectMemberSegment[] | null>(null)

/** 读取当前 thread 的 team 成员活动段（restore + live 统一模型）。 */
export const useProjectMemberSegments = () => {
  const segments = useContext(ProjectMemberSegmentsContext)

  if (!segments) {
    throw new Error('useProjectMemberSegments 必须在 ProjectAssistantRuntimeProvider 内使用。')
  }

  return segments
}

/** 读取连接恢复状态与手动重试入口（重连期间禁写、degraded 横幅用）。 */
export const useProjectConnection = useAguiConnection

/**
 * 为一个 project session 提供官方 AG-UI runtime。
 *
 * runtime 装配、restore→attach 触发与断线重连全部由通用
 * `AguiSessionRuntimeProvider` 承担（ADR-0005）；本层只补 producer team
 * 特有的两件事：restore 成员历史注水与 live `agui.member_event` 消费。
 */
export default function ProjectAssistantRuntimeProvider({
  children,
  onRuntimeError,
  sessionId,
}: ProjectAssistantRuntimeProviderProps) {
  const memberSegmentsStateRef = useRef(createProjectMemberSegmentsState())
  const [memberSegments, setMemberSegments] = useState<ProjectMemberSegment[]>([])

  const publishMemberSegments = useCallback(() => {
    setMemberSegments(projectMemberSegmentsSnapshot(memberSegmentsStateRef.current))
  }, [])

  const loadHistory = useCallback(
    async (threadSessionId: string): Promise<AguiRestoreHistory> => {
      const restored = await loadProjectRestoreHistory(threadSessionId)
      loadProjectMemberSegmentsFromRestore(memberSegmentsStateRef.current, restored.members)
      publishMemberSegments()
      return { activeRun: restored.activeRun, repository: restored.repository }
    },
    [publishMemberSegments],
  )

  const handleCustomEvent = useCallback(
    (event: AguiCustomEventPayload) => {
      if (event.name !== AGUI_MEMBER_EVENT_NAME) {
        return
      }

      const value = parseProjectMemberEventValue(event.value)
      if (value && applyProjectMemberEvent(memberSegmentsStateRef.current, value)) {
        publishMemberSegments()
      }
    },
    [publishMemberSegments],
  )

  return (
    <ProjectMemberSegmentsContext.Provider value={memberSegments}>
      <AguiSessionRuntimeProvider
        loadHistory={loadHistory}
        onCustomEvent={handleCustomEvent}
        onRuntimeError={onRuntimeError}
        runUrl={AGUI_RUN_ENDPOINT}
        sessionId={sessionId}
        showThinking
      >
        {children}
      </AguiSessionRuntimeProvider>
    </ProjectMemberSegmentsContext.Provider>
  )
}
