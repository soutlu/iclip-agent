import { queryOptions, useQuery } from '@tanstack/react-query'
import { type z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import { drainPages } from '@/shared/api/paging'
import type { VideoGenerationIn, VideoShotIn } from '@/shared/api/generated/types.gen'
import {
  zGenerationsPageOut,
  zVideoModelsOut,
  zVideoShotIn,
  zVideoSubmitOut,
} from '@/shared/api/generated/zod.gen'
import type { zGenerationOut } from '@/shared/api/generated/zod.gen'
import type { Shot } from './shot-document'
import { isRunningStatus } from './shots'

export type GenerationJob = z.infer<typeof zGenerationOut>

/** 列表接口的一页，按 zod 解析后的形状；查询缓存里存的就是它，与生成的 TS 类型在可选字段上不完全同形。 */
export type GenerationsPage = z.infer<typeof zGenerationsPageOut>

const PAGE_LIMIT = 100

const POLL_MS = 5000

/** 出片固定的分辨率。视频模型清单只给模型名、不给各家支持的档位，前端做不出下拉，就定一档。 */
const VIDEO_RESOLUTION = '720p'

const conversationGenerationsKey = (conversationId: string) =>
  ['generations', 'conversation', conversationId] as const

export const storyboardQueryKeys = {
  /** 本对话全部生成记录查询的前缀：视频记录、参考帧编辑、视频编辑链都挂在它下面，状态跳转帧到了
   * 失效它一次就全部重拉。模型清单不在这下面。 */
  conversation: conversationGenerationsKey,
  /** 本对话全部视频记录；分镜页与需求单面板共用这一份缓存。 */
  videoJobs: (conversationId: string) =>
    [...conversationGenerationsKey(conversationId), 'video'] as const,
  imageModels: ['generations', 'image-models'] as const,
  videoModels: ['generations', 'video-models'] as const,
}

/** 接入了哪几个视频模型。只有模型 id，下拉直接显示它；允许表随服务端配置走，前端不复制一份。 */
export const useVideoModels = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/generations/video-models', zVideoModelsOut, {
        fallbackErrorMessage: '读取视频模型失败',
        signal,
      }),
    queryKey: storyboardQueryKeys.videoModels,
    staleTime: Infinity,
  })

export type VideoGenerationInput = {
  conversationId: string
  aspectRatio: string
  model: string
  generateAudio: boolean
  shot: Shot
}

/** 历史记录里的结构化 shot，与分镜文件里的 prompt 同形，直接就能回填。
 *
 * 记录里没有 shot 的（接口调用方自己写的正文）回填不了，返回 undefined。 */
export const historyShotOf = (job: GenerationJob): Shot['prompt'] | undefined => {
  const parsed = zVideoShotIn.safeParse(job.request?.['shot'])
  return parsed.success ? parsed.data : undefined
}

/** 提交一次出片：镜头组与参考图照分镜当前这一版，字段名照上游异步接口（snake_case）。
 *
 * shot 就是分镜文件里这一组的 prompt 原样，正文由服务端拼，这里不发 prompt；镜号只走 shot_index。
 * 分辨率不跟分镜走，见 `VIDEO_RESOLUTION`。不带 user_name：浏览器会话由服务端填登录用户名。
 * 回执只有任务号，记录本身靠刷新列表拿到。 */
export const submitVideoGeneration = async (input: VideoGenerationInput): Promise<string> => {
  const shot: VideoShotIn = input.shot.prompt
  const body: VideoGenerationIn = {
    aspect_ratio: input.aspectRatio,
    conversation_id: input.conversationId,
    generate_audio: input.generateAudio,
    model: input.model,
    reference_image_urls: [...input.shot.image_urls],
    resolution: VIDEO_RESOLUTION,
    seconds: input.shot.seconds,
    shot,
    shot_index: input.shot.index,
  }
  const receipt = await apiFetch('/generations/video', zVideoSubmitOut, {
    body,
    fallbackErrorMessage: '视频提交失败',
    method: 'POST',
  })
  return receipt.task_id
}

/** 状态跳转帧到了由 useLiveGenerations 立刻失效；存在运行任务时仍每 5 秒轮询兜底，全部结束后停止。 */
export const generationsRefetchInterval = (
  items: readonly { status: GenerationJob['status'] }[],
): number | false => (items.some((item) => isRunningStatus(item.status)) ? POLL_MS : false)

const VIDEO_JOBS_ERROR = '读取视频记录失败'

/** 读完本对话的全部视频记录（含编辑链的衍生记录），按创建时间倒序。
 *
 * 只读第一页会让更早的出片静默消失：在途、失败与编辑结果都占名额。任一页失败整体抛错。 */
export const readConversationVideoJobs = (conversationId: string, signal: AbortSignal) =>
  drainPages<GenerationJob, string>(async (before) => {
    const params = new URLSearchParams({ conversationId, kind: 'video', limit: `${PAGE_LIMIT}` })
    if (before !== undefined) params.set('before', before)
    const page = await apiFetch(`/generations?${params}`, zGenerationsPageOut, {
      fallbackErrorMessage: VIDEO_JOBS_ERROR,
      signal,
    })
    // 筛选在分页截断前执行，不满一页就是读完了，省掉最后一次空页请求。
    if (page.items.length < PAGE_LIMIT) return { items: page.items, next: null }
    const last = page.items.at(-1)
    // 游标没往前走就说明分页坏了，再翻下去是死循环。
    if (last === undefined || last.id === before) {
      throw new ApiError(0, `${VIDEO_JOBS_ERROR}：分页异常，请重试`)
    }
    return { items: page.items, next: last.id }
  })

/** 本对话视频记录的查询配置；消费方各自用 `select` 投影，同一份数据只请求一次。 */
export const conversationVideoJobsQuery = (conversationId: string) =>
  queryOptions({
    queryFn: ({ signal }) => readConversationVideoJobs(conversationId, signal),
    queryKey: storyboardQueryKeys.videoJobs(conversationId),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

export const useShotGenerations = (conversationId: string) =>
  useQuery(conversationVideoJobsQuery(conversationId))
