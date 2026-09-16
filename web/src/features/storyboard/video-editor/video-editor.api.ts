/** 视频编辑的三次提交与链查询。切与合成走本地裁剪端点，编辑走出片端点（ADR-0028）。 */

import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type { ClipIn, VideoGenerationIn } from '@/shared/api/generated/types.gen'
import {
  zGenerationEnvelope,
  zGenerationsPageOut,
  type zVideoModelsOut,
  zVideoSubmitOut,
} from '@/shared/api/generated/zod.gen'
import { metadataFilterParam, type VideoEditMetadata } from '../generation-metadata'
import { generationsRefetchInterval, type GenerationJob } from '../storyboard.api'

/** 本对话全部编辑链的查询前缀；按根的键挂在它下面，状态跳转帧到了一次失效全部。 */
export const videoEditConversationKey = (conversationId: string) =>
  ['video-edits', conversationId] as const

export const videoEditChainKey = (conversationId: string, rootJob: string) =>
  [...videoEditConversationKey(conversationId), rootJob] as const

/** 一条根下面的编辑记录与成片。不带 kind：参考片段、成片（clip）与编辑结果（video）一次拿回。
 *
 * 根自己的坐标里没有 rootJob，不在结果里，由打开编辑器的那条记录传进来。 */
export const useVideoEditChain = (conversationId: string, rootJob: string) =>
  useQuery({
    queryKey: videoEditChainKey(conversationId, rootJob),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        conversationId,
        metadata: metadataFilterParam({ rootJob }),
        limit: '100',
      })
      return apiFetch(`/generations?${params}`, zGenerationsPageOut, {
        signal,
        fallbackErrorMessage: '读取编辑记录失败',
      })
    },
    // 编辑器按需打开，打开就重拉，不吃全局 30 秒的新鲜期。
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

export type VideoModel = z.infer<typeof zVideoModelsOut>['items'][number]

/** 声明了怎么触发编辑的那几个模型；`edit` 为空的做不了编辑，下拉里不列。 */
export const editableModels = (models: readonly VideoModel[]): VideoModel[] =>
  models.filter((model) => model.edit !== null && model.edit !== undefined)

type Origin = {
  conversationId: string
  /** 根记录归属的需求单，三条记录跟着它。 */
  taskId: string | null
  metadata: VideoEditMetadata
}

/** 从一条完整视频上切出 `[start, end)` 交给模型看。不重编码，产物会比区间略长、多在开头。 */
export const submitReferenceClip = async (
  input: Origin & { url: string; start: number; end: number },
): Promise<GenerationJob> => {
  const body: ClipIn = {
    conversationId: input.conversationId,
    taskId: input.taskId,
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
    model: VideoModel
    prompt: string
    referenceVideoUrl: string
    referenceImageUrls: readonly string[]
  },
): Promise<string> => {
  const edit = input.model.edit
  if (edit === null || edit === undefined)
    throw new Error(`模型 ${input.model.model} 不支持视频编辑`)
  const body: VideoGenerationIn = {
    conversation_id: input.conversationId,
    task_id: input.taskId,
    metadata: input.metadata,
    model: input.model.model,
    prompt: `${edit.promptPrefix ?? ''}${input.prompt}`,
    reference_video_urls: [input.referenceVideoUrl],
    reference_image_urls: [...input.referenceImageUrls],
    seconds: -1,
    ...(edit.providerOptions === null || edit.providerOptions === undefined
      ? {}
      : { provider_options: edit.providerOptions }),
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
