/** REST 信封使用 snake_case，实体使用 camelCase；对象中的 null 转为省略字段后，再经 vendor schema 校验。类型断言仅衔接 vendor 可选字段与 zod 的 undefined 差异。 */

import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zTranscriptPage } from '@/shared/api/generated/zod.gen'
import { MAIN_AGENT_ID } from './connection'
import {
  agentTranscriptSnapshotSchema,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
  transcriptOperationSchema,
} from './vendor'

export interface TranscriptBatch {
  seq: number
  ops: readonly TranscriptOperation[]
}

export interface TranscriptBaseline {
  snapshot: AgentTranscriptSnapshot
  seq: number
  hasMoreOlder: boolean
  /** 初始标题来自基线，后续改名由 session.meta.updated 推送。 */
  title: string
}

/** complete 为 false 表示批次已超出日志窗口，需重拉基线。 */
export interface TranscriptCatchup {
  batches: readonly TranscriptBatch[]
  latestSeq: number
  complete: boolean
}

/** 沿用 Kimi 客户端默认分页大小。 */
const PAGE_SIZE = 20

const operationsSchema = z.array(transcriptOperationSchema)

/** 生成的 zOpsCatchup 各分支 kind 默认值导致 zod v4 判别值 undefined 冲突；此处仅定义信封，操作仍由 vendor schema 校验。 */
const catchupSchema = z.object({
  agent_id: z.string(),
  batches: z.array(z.object({ ops: z.array(z.unknown()), seq: z.int() })),
  complete: z.boolean(),
  latest_seq: z.int(),
})

/** 仅删除对象中值为 null 的字段，数组元素和其他原始值保持不变。 */
const dropNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(dropNulls)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, dropNulls(field)]),
  )
}

/** 主流不带 agent_id，与只认 main 的旧请求形状一致；子代理流按它的 id 读。 */
const agentQuery = (agentId: string) =>
  agentId === MAIN_AGENT_ID ? '' : `&agent_id=${encodeURIComponent(agentId)}`

export const fetchTranscriptBaseline = async (
  conversationId: string,
  agentId: string = MAIN_AGENT_ID,
): Promise<TranscriptBaseline> => {
  const page = await apiFetch(
    `/conversations/${conversationId}/transcript?page_size=${PAGE_SIZE}${agentQuery(agentId)}`,
    zTranscriptPage,
    { cache: 'no-store', fallbackErrorMessage: '读取对话内容失败' },
  )
  const snapshot = agentTranscriptSnapshotSchema.parse(
    dropNulls({
      interactions: page.interactions,
      items: page.items,
      meta: page.meta,
      prompts: page.prompts,
      tasks: [],
      todos: [],
    }),
  ) as AgentTranscriptSnapshot
  return { hasMoreOlder: page.has_more, seq: page.seq, snapshot, title: page.title }
}

export const fetchTranscriptCatchup = async (
  conversationId: string,
  sinceSeq: number,
  agentId: string = MAIN_AGENT_ID,
): Promise<TranscriptCatchup> => {
  const catchup = await apiFetch(
    `/conversations/${conversationId}/transcript/ops?since_seq=${sinceSeq}${agentQuery(agentId)}`,
    catchupSchema,
    { cache: 'no-store', fallbackErrorMessage: '补取对话内容失败' },
  )
  return {
    batches: catchup.batches.map((batch) => ({
      ops: operationsSchema.parse(dropNulls(batch.ops)) as TranscriptOperation[],
      seq: batch.seq,
    })),
    complete: catchup.complete,
    latestSeq: catchup.latest_seq,
  }
}
