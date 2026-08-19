import type { AgentOSSessionStatus } from '@/features/chat'
import type { ProjectSessionTabIndicator } from '@/features/project-workspace/components/ProjectSessionTabs'
import type { ProducerProjectSession } from '@/features/projects'

export const PROJECT_SESSION_WARM_RUNTIME_LIMIT = 2

interface ProjectSessionRuntimeSubscriptionInput {
  activeGenerationSessionIds: readonly string[]
  activeSessionId: string | null
  maxWarmSessions?: number
  recentSessionIds: readonly string[]
  sessionRunStatuses: Partial<Record<string, AgentOSSessionStatus>>
  sessions: readonly ProducerProjectSession[]
}

interface ProjectSessionTabIndicatorsInput {
  activeGenerationSessionIds: readonly string[]
  sessionRunStatuses: Partial<Record<string, AgentOSSessionStatus>>
  sessions: readonly ProducerProjectSession[]
  unreadSessionIds: readonly string[]
}

const ACTIVE_RUN_STATUSES = new Set<AgentOSSessionStatus>(['PENDING', 'RUNNING', 'PAUSED'])

/**
 * 将 session id 加到最近访问列表顶部并去重。
 *
 * @param currentSessionIds - 当前最近访问 session id 列表。
 * @param sessionId - 新访问的 session id。
 * @returns 新的最近访问 session id 列表。
 */
export const addRecentProjectSessionId = (
  currentSessionIds: readonly string[],
  sessionId: string,
) => [sessionId, ...currentSessionIds.filter((currentSessionId) => currentSessionId !== sessionId)]

/**
 * 按当前项目 session 列表裁剪 session id 集合。
 *
 * @param currentSessionIds - 待裁剪的 session id 列表。
 * @param sessions - 当前项目 session 摘要列表。
 * @returns 只包含当前项目仍存在 session 的 id 列表。
 */
export const pruneProjectSessionIds = (
  currentSessionIds: readonly string[],
  sessions: readonly ProducerProjectSession[],
) => {
  const sessionIds = new Set(sessions.map((session) => session.id))

  return currentSessionIds.filter((sessionId) => sessionIds.has(sessionId))
}

/**
 * 按当前项目 session 列表裁剪官方 run 状态表。
 *
 * @param currentStatuses - 当前 session run 状态表。
 * @param sessions - 当前项目 session 摘要列表。
 * @returns 只包含当前项目仍存在 session 的 run 状态表。
 */
export const pruneProjectSessionRunStatuses = (
  currentStatuses: Record<string, AgentOSSessionStatus>,
  sessions: readonly ProducerProjectSession[],
) => {
  const sessionIds = new Set(sessions.map((session) => session.id))
  const nextStatuses: Record<string, AgentOSSessionStatus> = {}

  for (const [sessionId, status] of Object.entries(currentStatuses)) {
    if (sessionIds.has(sessionId)) {
      nextStatuses[sessionId] = status
    }
  }

  return nextStatuses
}

/**
 * 从互不覆盖的 run、生成与未读事实派生顶部 Tab 图标。
 *
 * @param input - 单个 session 的运行与 UI 事实。
 * @returns 当前 session 唯一的展示状态。
 */
const projectSessionTabIndicator = ({
  generationActive,
  isUnread,
  runStatus = 'COMPLETED',
}: {
  generationActive: boolean
  isUnread: boolean
  runStatus?: AgentOSSessionStatus
}): ProjectSessionTabIndicator => {
  if (runStatus === 'PAUSED') {
    return 'PAUSED'
  }

  if (runStatus === 'ERROR' || runStatus === 'CANCELLED') {
    return runStatus
  }

  if (runStatus === 'PENDING' || runStatus === 'RUNNING') {
    return runStatus
  }

  if (generationActive) {
    return 'RUNNING'
  }

  return isUnread ? 'UNREAD' : 'COMPLETED'
}

/**
 * 构造传给顶部 session tabs 的完整 indicator 表。
 *
 * @param input - 当前项目的 run、生成、未读与 session 事实。
 * @returns 每个 session 的有效 indicator 表。
 */
export const projectSessionIndicatorsForTabs = ({
  activeGenerationSessionIds,
  sessionRunStatuses,
  sessions,
  unreadSessionIds,
}: ProjectSessionTabIndicatorsInput) => {
  const generationSessionIds = new Set(activeGenerationSessionIds)
  const unreadIds = new Set(unreadSessionIds)

  return Object.fromEntries(
    sessions.map((session) => [
      session.id,
      projectSessionTabIndicator({
        generationActive: generationSessionIds.has(session.id),
        isUnread: unreadIds.has(session.id),
        runStatus: sessionRunStatuses[session.id],
      }),
    ]),
  ) as Record<string, ProjectSessionTabIndicator>
}

/**
 * 计算当前项目应挂载 AG-UI runtime 的 session 列表。
 *
 * 订阅集合固定为 active + 官方活跃 run + 活跃视频生成 + recent。
 *
 * @param input - 订阅策略输入。
 * @returns 按 active 优先、其余保持 session 列表顺序排列的 session 摘要。
 */
export const projectSessionsWithSubscribedRuntimes = ({
  activeGenerationSessionIds,
  activeSessionId,
  maxWarmSessions = PROJECT_SESSION_WARM_RUNTIME_LIMIT,
  recentSessionIds,
  sessionRunStatuses,
  sessions,
}: ProjectSessionRuntimeSubscriptionInput) => {
  const subscribed = new Set<string>()
  const generationSessionIds = new Set(activeGenerationSessionIds)

  if (activeSessionId) {
    subscribed.add(activeSessionId)
  }

  for (const session of sessions) {
    const runStatus = sessionRunStatuses[session.id]

    if ((runStatus && ACTIVE_RUN_STATUSES.has(runStatus)) || generationSessionIds.has(session.id)) {
      subscribed.add(session.id)
    }
  }

  for (const sessionId of recentSessionIds.slice(0, maxWarmSessions)) {
    subscribed.add(sessionId)
  }

  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId && subscribed.has(session.id))
    : undefined
  const restSessions = sessions.filter(
    (session) => session.id !== activeSessionId && subscribed.has(session.id),
  )

  return activeSession ? [activeSession, ...restSessions] : restSessions
}
