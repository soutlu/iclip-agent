import type { Message } from '@ag-ui/client'
import { ExportedMessageRepository, type ThreadMessageLike } from '@assistant-ui/react'
import type { ReadonlyJSONValue } from 'assistant-stream/utils'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { requiredStringSchema, wireRecordSchema } from '@/shared/api/schemas'
import { PRODUCER_AGUI_TARGET } from '@/shared/config/agui-target'
import { assistantMessagesFromAguiMessages } from '../runtime/project-agui-messages'
import type { ProjectRestoreMemberRun } from '../runtime/project-member-segments'

export const AGUI_RESTORE_ENDPOINT = `${PRODUCER_AGUI_TARGET.apiPrefix}/restore`

/** restore 响应里的在途 run 决策。 */
export interface AguiActiveRun {
  runId: string
}

export interface ProjectRestoreResult {
  activeRun: AguiActiveRun | null
  members: ProjectRestoreMemberRun[]
  repository: ReturnType<typeof ExportedMessageRepository.fromBranchableArray> & {
    state: ReadonlyJSONValue
    unstable_resume: boolean
  }
}

interface ProjectRestorePayload {
  activeRun: AguiActiveRun | null
  headId: string | null
  members: ProjectRestoreMemberRun[]
  messages: Message[]
  state: Record<string, unknown>
}

const projectRestoreMemberSchema = z
  .object(
    {
      memberId: requiredStringSchema('AG-UI restore member 缺少 memberId。'),
      memberRunId: requiredStringSchema('AG-UI restore member 缺少 memberRunId。'),
      messages: z.array(wireRecordSchema('AG-UI restore member message 必须是 object。')),
      parentToolCallId: z.string().nullable(),
      status: z.string(),
    },
    { error: 'AG-UI restore member 格式无效。' },
  )
  .transform((member): ProjectRestoreMemberRun => ({
    ...member,
    messages: member.messages as Message[],
  }))

const projectRestorePayloadSchema = z
  .object(
    {
      activeRun: z
        .object(
          { runId: requiredStringSchema('AG-UI restore activeRun 缺少 runId。') },
          { error: 'AG-UI restore activeRun 格式无效。' },
        )
        .nullable(),
      headId: z.string().nullable(),
      members: z.array(projectRestoreMemberSchema, {
        error: 'AG-UI restore 响应缺少 members 数组。',
      }),
      messages: z.array(wireRecordSchema('AG-UI restore message 必须是 object。'), {
        error: 'AG-UI restore 响应缺少 messages 数组。',
      }),
      state: wireRecordSchema('AG-UI restore 响应缺少 state object。'),
    },
    { error: 'AG-UI restore 响应必须是 JSON object。' },
  )
  .transform((payload): ProjectRestorePayload => ({
    ...payload,
    messages: payload.messages as Message[],
  }))

/**
 * 把 message-like 数组转成 assistant-ui branchable history repository。
 *
 * @param messages - 带稳定 id 的 assistant-ui message-like 列表。
 * @param headId - 后端 restore payload 返回的 headId。
 * @returns assistant-ui history adapter 可返回的 repository。
 */
export const repositoryFromMessages = (
  messages: readonly ThreadMessageLike[],
  headId: string | null,
) => {
  return ExportedMessageRepository.fromBranchableArray(
    messages.map((message, index) => ({
      message,
      parentId: index > 0 ? (messages[index - 1]?.id ?? null) : null,
    })),
    { headId },
  )
}

/**
 * 请求后端 restore JSON payload。
 *
 * @param sessionId - 当前 Agno session id，同时作为 AG-UI threadId。
 * @returns 后端 restore payload（含 activeRun 恢复决策）。
 */
const fetchProjectRestorePayload = (sessionId: string) =>
  apiFetch(`${PRODUCER_AGUI_TARGET.path}/restore`, projectRestorePayloadSchema, {
    body: {
      threadId: sessionId,
    },
    cache: 'no-store',
    fallbackErrorMessage: '加载 AG-UI restore 失败',
    headers: {
      Accept: 'application/json',
    },
    method: 'POST',
  })

/**
 * 加载 restore repository 与后端恢复决策。
 *
 * 「是否有 run 可重连」只由响应中的 `activeRun` 决定（后端归因唯一权威，
 * ADR-0005）；前端不再查询 runs 列表，也不做任何本地判定。
 *
 * @param sessionId - 当前 Agno session id，同时作为 AG-UI threadId。
 * @returns restore repository、成员历史与 activeRun 决策。
 */
export const loadProjectRestoreHistory = async (
  sessionId: string,
): Promise<ProjectRestoreResult> => {
  const payload = await fetchProjectRestorePayload(sessionId)
  const messages = assistantMessagesFromAguiMessages(payload.messages)

  return {
    activeRun: payload.activeRun,
    members: payload.members,
    repository: {
      ...repositoryFromMessages(messages, payload.headId),
      state: payload.state as ReadonlyJSONValue,
      // assistant-ui 的 history.resume 是 ChatModel snapshot 流，不是 AG-UI
      // transport；重连由 provider 在注水后触发一次普通 startRun。
      unstable_resume: false,
    },
  }
}
