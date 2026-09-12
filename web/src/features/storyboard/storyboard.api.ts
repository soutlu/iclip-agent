import { useQuery } from '@tanstack/react-query'
import { type z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { MEDIA_IMAGE_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import type { VideoGenerationIn, VideoShotIn } from '@/shared/api/generated/types.gen'
import {
  zGenerationsPageOut,
  zVideoModelsOut,
  zVideoShotIn,
  zVideoSubmitOut,
} from '@/shared/api/generated/zod.gen'
import type { zGenerationOut } from '@/shared/api/generated/zod.gen'
import { storyboardMetadata } from './generation-metadata'
import type { Shot } from './shot-document'
import { isRunningStatus } from './shots'

export type GenerationJob = z.infer<typeof zGenerationOut>

const PAGE_LIMIT = 100

const POLL_MS = 5000

export const storyboardQueryKeys = {
  generations: (conversationId: string) => ['generations', { conversationId }] as const,
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
  /** 分镜文件路径，与镜头组一起写进任务坐标 metadata（ADR-0020）。 */
  path: string
  aspectRatio: string
  model: string
  generateAudio: boolean
  shot: Shot
}

/** 历史记录里的结构化 shot，与分镜文件里的 prompt 同形，直接就能回填。
 *
 * 记录里没有 shot 的（接口调用方自己写的正文）回填不了，返回 undefined。 */
export const historyShotOf = (job: GenerationJob): Shot['prompt'] | undefined => {
  const parsed = zVideoShotIn.safeParse(job.request['shot'])
  return parsed.success ? parsed.data : undefined
}

/** 提交一次出片：镜头组与参考图照分镜当前这一版，字段名照上游异步接口（snake_case）。
 *
 * shot 就是分镜文件里这一组的 prompt 原样，正文由服务端拼，这里不发 prompt。不带 user_name：
 * 浏览器会话由服务端填登录用户名。回执只有任务号，记录本身靠刷新列表拿到。 */
export const submitVideoGeneration = async (input: VideoGenerationInput): Promise<string> => {
  const shot: VideoShotIn = input.shot.prompt
  const body: VideoGenerationIn = {
    aspect_ratio: input.aspectRatio,
    conversation_id: input.conversationId,
    generate_audio: input.generateAudio,
    metadata: storyboardMetadata(input.path, input.shot.index),
    model: input.model,
    reference_image_urls: [...input.shot.image_urls],
    seconds: input.shot.seconds,
    shot,
  }
  const receipt = await apiFetch('/generations/video', zVideoSubmitOut, {
    body,
    fallbackErrorMessage: '出片没发出去',
    method: 'POST',
  })
  return receipt.task_id
}

/** 状态跳转帧到了由 useLiveGenerations 立刻失效；存在运行任务时仍每 5 秒轮询兜底，全部结束后停止。 */
export const generationsRefetchInterval = (items: readonly { status: string }[]): number | false =>
  items.some((item) => isRunningStatus(item.status)) ? POLL_MS : false

export const useShotGenerations = (conversationId: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(
        `/generations?conversationId=${conversationId}&kind=video&limit=${PAGE_LIMIT}`,
        zGenerationsPageOut,
        { fallbackErrorMessage: '读取生成任务失败', signal },
      ),
    queryKey: storyboardQueryKeys.generations(conversationId),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

export const FRAME_IMAGE_ACCEPT = MEDIA_IMAGE_ACCEPT

/** 上传并确认本地图片，返回可用于分镜引用的地址。 */
export const uploadFrameImage = (file: File): Promise<string> => uploadMediaFile(file, 'image')
