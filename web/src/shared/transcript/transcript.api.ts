/**
 * transcript 的 REST 读取面：基线一页与补批。两者都在这里换成 reducer 认的形状。
 *
 * 翻译只有这一处。两边差两点：合同生成的 schema 允许 null（后端的 REST 响应不省略空字段，
 * 发出来的是 `"prompt": null`），而协议里那些字段是「没有就不写」，reducer 那份照抄来的 zod
 * 用的是 `.optional()`；另外信封是 snake_case，实体是 camelCase。
 *
 * **null 必须在这里摘掉**：带着 null 交给 reducer，它的 zod 会拒掉整份而且不报错，界面就此停在
 * 空白。摘干净之后再用 vendor 的 schema 过一遍——形状哪天漂了会当场抛出来，不是安静地少一块。
 *
 * 两处 `as` 是 vendor 那两格宽松（见 `tsconfig.vendor.json`）在类型上的接缝：它的声明写的是
 * `taskId?: string`，而 zod 推出来的是 `taskId?: string | undefined`。运行时同一件事，本仓严格
 * 档下不通，只在这一处收口。
 */

import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zTranscriptPage } from '@/shared/api/generated/zod.gen'
import {
  agentTranscriptSnapshotSchema,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
  transcriptOperationSchema,
} from './vendor'

/** 一批操作：批次号加这一批的内容。 */
export interface TranscriptBatch {
  seq: number
  ops: readonly TranscriptOperation[]
}

/** 基线：一页轮子换成的快照，与它对应的水位。 */
export interface TranscriptBaseline {
  snapshot: AgentTranscriptSnapshot
  seq: number
  hasMoreOlder: boolean
  /** 这段对话叫什么。首屏的标题只有它给，之后的改名走 `session.meta.updated` 推送。 */
  title: string
}

/** 补批的结果。`complete` 为假表示要的批次已经出了日志窗口，得整页重拉。 */
export interface TranscriptCatchup {
  batches: readonly TranscriptBatch[]
  latestSeq: number
  complete: boolean
}

/** 一页取几轮。照 kimi 出厂客户端的默认值。 */
const PAGE_SIZE = 20

const operationsSchema = z.array(transcriptOperationSchema)

/**
 * 补批响应的信封。
 *
 * 这一条不用生成的 `zOpsCatchup`：它里面 `frame.upsert` 的 `frame` 是个判别联合，而生成出来的
 * 每一支 `kind` 都带默认值（`z.literal('text').optional().default('text')`），zod v4 建判别表时
 * 四支的判别值都是 `undefined`，一撞车就直接抛 `Duplicate discriminator value`——**任何**一次
 * 补批都过不去，客户端于是反复整页重拉。信封在这里写一份，操作本身仍由下面 vendor 那份
 * schema 逐条校验。
 */
const catchupSchema = z.object({
  agent_id: z.string(),
  batches: z.array(z.object({ ops: z.array(z.unknown()), seq: z.int() })),
  complete: z.boolean(),
  latest_seq: z.int(),
})

/**
 * 递归摘掉所有值为 null 的字段。
 *
 * 数组原样递归，其余原始值照过：只有对象里的 null 字段会消失。
 */
const dropNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(dropNulls)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, dropNulls(field)]),
  )
}

/** 拉最新的一页当基线。 */
export const fetchTranscriptBaseline = async (
  conversationId: string,
): Promise<TranscriptBaseline> => {
  const page = await apiFetch(
    `/conversations/${conversationId}/transcript?page_size=${PAGE_SIZE}`,
    zTranscriptPage,
    { cache: 'no-store', fallbackErrorMessage: '读取对话内容失败' },
  )
  const snapshot = agentTranscriptSnapshotSchema.parse(
    dropNulls({
      interactions: page.interactions,
      items: page.items,
      meta: page.meta,
      prompts: page.prompts,
      // 后台任务与待办我们没有产地，恒空。
      tasks: [],
      todos: [],
    }),
  ) as AgentTranscriptSnapshot
  return { hasMoreOlder: page.has_more, seq: page.seq, snapshot, title: page.title }
}

/** 要断线期间漏掉的那几批。 */
export const fetchTranscriptCatchup = async (
  conversationId: string,
  sinceSeq: number,
): Promise<TranscriptCatchup> => {
  const catchup = await apiFetch(
    `/conversations/${conversationId}/transcript/ops?since_seq=${sinceSeq}`,
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
