import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'

const agentOSRunsPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/runs`

export const agentOSRunsEndpoint = (sessionId: string) => `/api${agentOSRunsPath(sessionId)}`

export const AGENTOS_RUN_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PAUSED',
  'CANCELLED',
  'ERROR',
  'REGENERATED',
] as const

export type AgentOSRunStatus = (typeof AGENTOS_RUN_STATUSES)[number]
export type AgentOSSessionStatus = Exclude<AgentOSRunStatus, 'REGENERATED'>

export interface AgentOSRunSummary {
  parent_run_id?: string | null
  run_id: string
  status: AgentOSRunStatus
}

const AGENTOS_RUN_STATUS_SET = new Set<string>(AGENTOS_RUN_STATUSES)

/**
 * 判断字符串是否是 Agno 官方 run status。
 *
 * @param value - 需要检查的字符串。
 * @returns 是官方 run status 时返回 true。
 */
export const isAgentOSRunStatus = (value: string): value is AgentOSRunStatus =>
  AGENTOS_RUN_STATUS_SET.has(value)

/** 官方 AgentOS runs list 响应 wire schema。 */
const agentOSRunsSchema = z.array(
  z.object(
    {
      parent_run_id: z.string().nullable().optional(),
      run_id: z.string({ error: 'AgentOS runs 响应缺少 run_id 或 status。' }),
      status: z
        .string({ error: 'AgentOS runs 响应缺少 run_id 或 status。' })
        .refine(isAgentOSRunStatus, {
          error: (issue) => `AgentOS run status 无效：${String(issue.input)}`,
        }),
    },
    { error: 'AgentOS runs 响应缺少 run_id 或 status。' },
  ),
  { error: 'AgentOS runs 响应必须是 JSON array。' },
)

/**
 * 从官方 AgentOS runs list 响应中读取 run 摘要。
 *
 * @param payload - runs 端点返回的未知 JSON。
 * @returns 已收窄的 run 摘要数组。
 */
export const normalizeAgentOSRunsPayload = (payload: unknown): AgentOSRunSummary[] =>
  agentOSRunsSchema.parse(payload)

/**
 * 从 AgentOS session runs 中选出顶层 Agent/Team runs。
 *
 * 官方 session 路由同时返回 Team member child runs；Productor 的 session 状态与
 * session 状态只由顶层 run 决定。
 */
export const topLevelAgentOSRuns = (runs: readonly AgentOSRunSummary[]) =>
  runs.filter((run) => !run.parent_run_id)

/**
 * 请求官方 AgentOS runs list。
 *
 * @param sessionId - 当前 Agno session id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 当前 session 下的官方 run 摘要。
 */
export const fetchAgentOSRuns = async (
  sessionId: string,
  { signal }: { signal?: AbortSignal } = {},
) => {
  return apiFetch(agentOSRunsPath(sessionId), agentOSRunsSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '加载 AgentOS runs 失败',
    headers: {
      Accept: 'application/json',
    },
    method: 'GET',
    signal,
  })
}

/**
 * 将官方 runs list 投影为 session tab 当前状态。
 *
 * @param runs - 当前 session 下的官方 run 摘要。
 * @returns 最新 run status；没有 run 时视为 completed。
 */
export const sessionStatusFromAgentOSRuns = (
  runs: readonly AgentOSRunSummary[],
): AgentOSSessionStatus =>
  topLevelAgentOSRuns(runs)
    .filter(
      (
        run,
      ): run is AgentOSRunSummary & {
        status: AgentOSSessionStatus
      } => run.status !== 'REGENERATED',
    )
    .at(-1)?.status ?? 'COMPLETED'
