import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { MEDIA_IMAGE_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'
import {
  zGenerationsPageOut,
  zVideoModelsOut,
  zVideoSubmitOut,
} from '@/shared/api/generated/zod.gen'
import type { zGenerationOut } from '@/shared/api/generated/zod.gen'
import { useWorkspaceFiles } from '@/shared/workbench'
import { formatShotPrompt, type Shot } from './shot-document'
import { isRunningStatus } from './shots'

export type GenerationJob = z.infer<typeof zGenerationOut>

const PAGE_LIMIT = 100

const POLL_MS = 5000

export const storyboardQueryKeys = {
  frameCandidates: (conversationId: string) =>
    ['conversations', conversationId, 'workspace', 'frame-candidates'] as const,
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
  aspectRatio: string
  model: string
  generateAudio: boolean
  shot: Shot
}

/** 提交一次出片：正文与参考图照分镜当前这一版，字段名照上游异步接口（snake_case）。
 *
 * 不带 user_name：浏览器会话由服务端填登录用户名。回执只有任务号，记录本身靠刷新列表拿到。 */
export const submitVideoGeneration = async (input: VideoGenerationInput): Promise<string> => {
  const body: VideoGenerationIn = {
    aspect_ratio: input.aspectRatio,
    conversation_id: input.conversationId,
    generate_audio: input.generateAudio,
    model: input.model,
    prompt: formatShotPrompt(input.shot),
    reference_image_urls: [...input.shot.image_urls],
    seconds: input.shot.seconds,
    shot_index: input.shot.index,
  }
  const receipt = await apiFetch('/generations/video', zVideoSubmitOut, {
    body,
    fallbackErrorMessage: '出片没发出去',
    method: 'POST',
  })
  return receipt.task_id
}

/** 服务端未推送生成进度；存在运行任务时每 5 秒轮询，全部结束后停止。 */
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

/** 帧版记录位于 frames/grids/<jobId>.json。 */
const gridRecordSchema = z.object({
  frames: z.array(z.object({ no: z.string(), url: z.string() })),
})

const GRID_RECORDS_PREFIX = 'frames/grids/'

export type FrameCandidate = { url: string; label: string }

const fileContentSchema = z.object({
  file: z.object({ content: z.string(), path: z.string(), version: z.int() }),
})

/** 从持久化工作区读取候选帧并按 URL 去重，不依赖 transcript 生命周期。 */
export const useFrameCandidates = (conversationId: string) => {
  const files = useWorkspaceFiles(conversationId)
  const recordPaths = (files.data?.files ?? [])
    .map((file) => file.path)
    .filter((path) => path.startsWith(GRID_RECORDS_PREFIX) && path.endsWith('.json'))
    .sort()
  return useQuery({
    enabled: files.data !== undefined,
    queryFn: async ({ signal }) => {
      const records = await Promise.all(
        recordPaths.map((path) =>
          apiFetch(
            `/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(path)}`,
            fileContentSchema,
            { fallbackErrorMessage: '读取帧记录失败', signal },
          ),
        ),
      )
      const seen = new Set<string>()
      const candidates: FrameCandidate[] = []
      for (const record of records) {
        const parsed = gridRecordSchema.safeParse(JSON.parse(record.file.content))
        if (!parsed.success) continue
        for (const frame of parsed.data.frames) {
          if (seen.has(frame.url)) continue
          seen.add(frame.url)
          candidates.push({ label: frame.no, url: frame.url })
        }
      }
      return candidates
    },
    queryKey: [...storyboardQueryKeys.frameCandidates(conversationId), recordPaths],
  })
}

export const FRAME_IMAGE_ACCEPT = MEDIA_IMAGE_ACCEPT

/** 上传并登记本地图片，返回可用于分镜引用的素材地址。 */
export const uploadFrameImage = (file: File): Promise<string> => uploadMediaFile(file, 'image')
