import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { ImageModelOut } from '@/shared/api/generated/types.gen'
import {
  zGenerationEnvelope,
  zGenerationsPageOut,
  zImageGenerationIn,
  zImageModelsOut,
} from '@/shared/api/generated/zod.gen'
import { metadataFilterParam, storyboardMetadata } from '../generation-metadata'
import { generationsRefetchInterval, type GenerationJob } from '../storyboard.api'
import { isRunningStatus } from '../shots'
import type { EditInstruction, FrameEditDraft, FrameEditTarget } from './image-edit-types'

/** 本对话全部参考帧编辑记录的查询前缀；按格的键挂在它下面，失效前缀即失效全部。 */
export const imageEditConversationKey = (conversationId: string) =>
  ['frame-edits', conversationId] as const

export const imageEditQueryKey = (target: FrameEditTarget) =>
  [
    ...imageEditConversationKey(target.conversationId),
    target.shotIndex,
    target.frameNumber,
  ] as const

/** 本对话最近的图片任务，给分镜页在帧上挂状态用。
 *
 * 键就是按格查询的前缀，一次失效两边一起重拉；倒序取 100 条够用，在跑的任务一定是最近的。
 * 状态跳转帧到了由 useLiveGenerations 立刻失效；有任务在跑时仍每 5 秒轮询兜底。 */
export const useFrameImageJobs = (conversationId: string) =>
  useQuery({
    queryKey: imageEditConversationKey(conversationId),
    queryFn: ({ signal }) =>
      apiFetch(
        `/generations?conversationId=${conversationId}&kind=image&limit=100`,
        zGenerationsPageOut,
        { signal, fallbackErrorMessage: '读取图片任务失败' },
      ),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

export function useImageEditJobs(target: FrameEditTarget) {
  return useInfiniteQuery({
    queryKey: imageEditQueryKey(target),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        conversationId: target.conversationId,
        kind: 'image',
        metadata: metadataFilterParam(
          storyboardMetadata(target.artifactPath, target.shotIndex, target.frameNumber),
        ),
        limit: '20',
      })
      if (pageParam !== undefined) params.set('before', pageParam)
      return apiFetch(`/generations?${params}`, zGenerationsPageOut, {
        signal,
        fallbackErrorMessage: '读取图片编辑记录失败',
      })
    },
    getNextPageParam: (page) => (page.items.length >= 20 ? page.items.at(-1)?.id : undefined),
    // 编辑器按需打开，页面上的角标可能已经知道任务落定了；打开就重拉，不吃全局 30 秒的新鲜期。
    staleTime: 0,
    // 状态跳转帧到了由 useLiveGenerations 立刻失效；有任务在跑时仍每 5 秒轮询兜底。
    refetchInterval: ({ state }) =>
      state.data?.pages.some((page) => page.items.some((job) => isRunningStatus(job.status)))
        ? 5000
        : false,
  })
}

/** 提交过的那一批图片，用来把历史记录装回编辑器。 */
export const readSubmittedImages = (job: GenerationJob) => {
  const urls = job.request['referenceImageUrls']
  return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string') : []
}

export const readSubmittedPrompt = (job: GenerationJob) => {
  const prompt = job.request['prompt']
  return typeof prompt === 'string' ? prompt : ''
}

/** 不说这句，模型会把圈和编号一起画进结果里。 */
const ANNOTATION_NOTICE = '图中的编号和圈选只表示位置，输出干净的图片，不保留标注。'
const IMAGE_MARK = /@图片(\d+)/g

/** 芯片落成 `@图片N` / `@标注N`；编号即它在本次提交里的位置，与仓里 `@ImageN` 同一套写法。 */
export function compileEditPrompt(draft: FrameEditDraft): string {
  const indexOf = new Map(draft.references.map((reference, at) => [reference.id, at + 1]))
  const numberOf = new Map(
    draft.annotations.map((annotation) => [annotation.id, annotation.number]),
  )
  const annotated = draft.references.some((reference) => reference.kind === 'annotated')
  const body = draft.instructions
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : part.kind === 'referenceImage'
          ? `@图片${indexOf.get(part.id)}`
          : `@标注${numberOf.get(part.id)}`,
    )
    .join('')
  return annotated ? `${body}\n${ANNOTATION_NOTICE}` : body
}

/** 把提交过的 prompt 拆回编辑器：`@图片N` 装回芯片，其余原样留成文字。
 *
 * `@标注N` 只能留成文字——芯片要指向画布上那个圈，而圈的形状没有随请求存下来。 */
export function parseEditPrompt(
  prompt: string,
  references: readonly { id: string }[],
): EditInstruction[] {
  const body = prompt.replace(`\n${ANNOTATION_NOTICE}`, '')
  const parts: EditInstruction[] = []
  const pushText = (text: string) => {
    if (text.length > 0) parts.push({ kind: 'text', text })
  }
  let at = 0
  for (const match of body.matchAll(IMAGE_MARK)) {
    const reference = references[Number(match[1]) - 1]
    if (reference === undefined) continue
    pushText(body.slice(at, match.index))
    parts.push({ kind: 'referenceImage', id: reference.id })
    at = match.index + match[0].length
  }
  pushText(body.slice(at))
  return parts
}

export type ImageModel = ImageModelOut

/** 接入了哪几家图片模型、各家支持什么档位。可选项与受理层照同一份声明，不在前端复制一份。 */
export function useImageModels() {
  return useQuery({
    queryKey: ['generations', 'image-models'] as const,
    queryFn: ({ signal }) =>
      apiFetch('/generations/image-models', zImageModelsOut, {
        signal,
        fallbackErrorMessage: '读取图片模型失败',
      }),
    staleTime: Infinity,
  })
}

/** 这家支持这个画幅吗。画幅由分镜决定，用户在编辑器里改不了。 */
export const modelSupportsAspect = (model: ImageModel, aspectRatio: string) =>
  model.aspectRatios.includes(aspectRatio)

export type ImageResolution = '1k' | '2k' | '4k'
export type ImageChannel = 'dev' | 'pro'

export type ResolvedImageOptions = {
  model: ImageModel | undefined
  resolution: ImageResolution | undefined
  channel: ImageChannel | undefined
  /** 一家都出不了这个画幅：不是选错了，是这个画幅没人支持。 */
  aspectUnsupported: boolean
}

/** 把「用户想要的」收敛成「这次真能提交的」。
 *
 * 各家支持的档位不同，切模型后旧的选择可能落在新模型的范围外；在这里收敛而不是用副作用
 * 改 state，切回去时用户原来的选择还在。画幅是分镜给的，改不了，所以它反过来筛模型。 */
export function resolveImageOptions(
  models: readonly ImageModel[],
  aspectRatio: string,
  wanted: { model?: string | undefined; resolution: ImageResolution; channel: ImageChannel },
): ResolvedImageOptions {
  const usable = models.filter((model) => modelSupportsAspect(model, aspectRatio))
  const model = usable.find((item) => item.model === wanted.model) ?? usable[0]
  if (model === undefined) {
    return {
      model: undefined,
      resolution: undefined,
      channel: undefined,
      aspectUnsupported: models.length > 0,
    }
  }
  const resolutions = model.resolutions.filter(isResolution)
  const channels = model.channels.filter(isChannel)
  return {
    model,
    resolution: resolutions.includes(wanted.resolution) ? wanted.resolution : resolutions.at(-1),
    // 空数组即这家没有渠道这个轴，提交时不带这个字段。
    channel: channels.includes(wanted.channel) ? wanted.channel : channels[0],
    aspectUnsupported: false,
  }
}

const RESOLUTIONS: readonly string[] = zImageGenerationIn.shape.resolution.unwrap().unwrap().options
const CHANNELS: readonly string[] = zImageGenerationIn.shape.channel.unwrap().unwrap().options

const isResolution = (value: string): value is ImageResolution => RESOLUTIONS.includes(value)
const isChannel = (value: string): value is ImageChannel => CHANNELS.includes(value)

export async function submitImageEdit(
  target: FrameEditTarget,
  draft: FrameEditDraft,
  options: {
    model: string
    channel?: 'dev' | 'pro'
    resolution: '1k' | '2k' | '4k'
    aspectRatio: string
  },
) {
  // 不带 userName：浏览器会话由服务端填登录用户名。
  const body = zImageGenerationIn.parse({
    conversationId: target.conversationId,
    metadata: storyboardMetadata(target.artifactPath, target.shotIndex, target.frameNumber),
    ...options,
    prompt: compileEditPrompt(draft),
    referenceImageUrls: draft.references.map((reference) => reference.url),
  })
  const result = await apiFetch('/generations/image', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '图片编辑任务提交失败',
  })
  return result.generation
}
