/** 视频编辑的三次提交与链查询。切与合成走本地裁剪端点，编辑走出片端点。 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type {
  ClipIn,
  GenerationsPageOut,
  VideoGenerationIn,
} from '@/shared/api/generated/types.gen'
import {
  zGenerationEnvelope,
  zGenerationsPageOut,
  zVideoSubmitOut,
} from '@/shared/api/generated/zod.gen'
import type { VideoEditMetadata } from '../generation-metadata'
import {
  generationsRefetchInterval,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'

/** 本对话全部编辑链的查询前缀，挂在本对话生成记录的前缀下；按根的键挂在它下面，一次失效全部。 */
export const videoEditConversationKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'video-edits'] as const

export const videoEditChainKey = (conversationId: string, rootJobId: string) =>
  [...videoEditConversationKey(conversationId), rootJobId] as const

/** 一条根名下的衍生记录：参考片段、成片（clip）与编辑结果（video）一次拿回，按原作号筛。
 *
 * 根自己的原作号是空的，不在结果里，由打开编辑器的那条记录传进来。 */
export const useVideoEditChain = (conversationId: string, rootJobId: string) =>
  useQuery({
    queryKey: videoEditChainKey(conversationId, rootJobId),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ conversationId, rootJobId, limit: '100' })
      return apiFetch(`/generations?${params}`, zGenerationsPageOut, {
        signal,
        fallbackErrorMessage: '读取编辑记录失败',
      })
    },
    // 编辑器按需打开，打开就重拉，不吃全局 30 秒的新鲜期。
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

/** 刚受理的记录先放进这条链的缓存最前面，再失效本对话全部编辑链，等服务端结果覆盖。 */
export const seedVideoEditJob = (
  queryClient: QueryClient,
  conversationId: string,
  rootJobId: string,
  job: GenerationJob,
) => {
  queryClient.setQueryData<GenerationsPageOut>(
    videoEditChainKey(conversationId, rootJobId),
    (previous) => ({
      items: [job, ...(previous?.items ?? []).filter((item) => item.id !== job.id)],
    }),
  )
  void queryClient.invalidateQueries({ queryKey: videoEditConversationKey(conversationId) })
}

/** 编辑时请求里要多带的东西：正文前缀，或并进 `provider_options` 的键值。 */
export type EditTrigger = {
  promptPrefix?: string
  providerOptions?: Record<string, string>
}

/** 哪个模型能做视频编辑、怎么触发。上游没有接口交代这件事，服务端也不管，按模型名认。
 * 按片段匹配：同一个模型在网关上有 `moyu-` / `mmt-` 两种前缀。 */
const EDIT_TRIGGERS: readonly { matches: RegExp; trigger: EditTrigger }[] = [
  // Seedance 2.5 靠 provider_options 显式声明编辑子任务，不认正文里的意图词。
  { matches: /seedance-2-5/, trigger: { providerOptions: { omni_reference_task_type: 'edit' } } },
  // 万相 3.0 没有开关参数，靠正文开头的意图词路由到编辑。
  { matches: /wan3/, trigger: { promptPrefix: '编辑视频，' } },
]

export const editTriggerOf = (model: string): EditTrigger | undefined =>
  EDIT_TRIGGERS.find((entry) => entry.matches.test(model))?.trigger

/** 允许表里前端认得怎么触发编辑的那几个；别的做不了编辑，下拉里不列。 */
export const editableModels = (models: readonly string[]): string[] =>
  models.filter((model) => editTriggerOf(model) !== undefined)

/** 编辑器用哪个模型：选过的不在允许表里（配置改了）就退回默认；默认模型不支持编辑就取第一个支持的。 */
export const pickEditModel = (
  models: readonly string[],
  wanted: string | undefined,
  fallback: string | undefined,
): string | undefined =>
  models.find((item) => item === wanted) ?? models.find((item) => item === fallback) ?? models[0]

type Origin = {
  conversationId: string
  /** 根记录归属的需求单，三条记录跟着它。 */
  taskId: string | null
  /** 最初那条出片：三条记录都是它的衍生记录，不管这次基于哪一版。 */
  rootJobId: string
  metadata: VideoEditMetadata
}

/** 从一条完整视频上切出 `[start, end)` 交给模型看。不重编码，产物会比区间略长、多在开头。 */
export const submitReferenceClip = async (
  input: Origin & { url: string; start: number; end: number },
): Promise<GenerationJob> => {
  const body: ClipIn = {
    conversationId: input.conversationId,
    taskId: input.taskId,
    rootJobId: input.rootJobId,
    metadata: input.metadata,
    purpose: 'reference',
    segments: [{ url: input.url, start: input.start, end: input.end }],
  }
  const result = await apiFetch('/generations/clips', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '切片任务提交失败',
  })
  return result.generation
}

/** 把参考片段交给模型改。怎么触发编辑照模型自报的 `edit`：前缀拼进正文、选项并进 provider_options。
 *
 * `seconds: -1` 让结果跟着参考片段的时长走；不显式给，网关按默认 5 秒截断。不带 user_name：
 * 浏览器会话由服务端填登录用户名。回执只有任务号。 */
export const submitVideoEdit = async (
  input: Origin & {
    model: string
    prompt: string
    referenceVideoUrl: string
    referenceImageUrls: readonly string[]
  },
): Promise<string> => {
  const edit = editTriggerOf(input.model)
  if (edit === undefined) throw new Error(`模型 ${input.model} 不支持视频编辑`)
  const body: VideoGenerationIn = {
    conversation_id: input.conversationId,
    task_id: input.taskId,
    root_job_id: input.rootJobId,
    metadata: input.metadata,
    model: input.model,
    prompt: `${edit.promptPrefix ?? ''}${input.prompt}`,
    reference_video_urls: [input.referenceVideoUrl],
    reference_image_urls: [...input.referenceImageUrls],
    seconds: -1,
    ...(edit.providerOptions === undefined ? {} : { provider_options: edit.providerOptions }),
  }
  const receipt = await apiFetch('/generations/video', zVideoSubmitOut, {
    method: 'POST',
    body,
    fallbackErrorMessage: '视频编辑提交失败',
  })
  return receipt.task_id
}

/** 按顺序把各段拼成一条成片。一律重编码、对齐到原片；成片长期保留，成为新的一版。 */
export const submitMasterClip = async (
  input: Origin & { segments: readonly { url: string; start: number; end: number }[] },
): Promise<GenerationJob> => {
  const body: ClipIn = {
    conversationId: input.conversationId,
    taskId: input.taskId,
    rootJobId: input.rootJobId,
    metadata: input.metadata,
    purpose: 'master',
    segments: [...input.segments],
  }
  const result = await apiFetch('/generations/clips', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '合成任务提交失败',
  })
  return result.generation
}
