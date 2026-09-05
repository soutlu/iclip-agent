import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zAssetEnvelope,
  zGenerationEnvelope,
  zGenerationsPageOut,
  zUploadTicketOut,
  zVideoGenerationIn,
} from '@/shared/api/generated/zod.gen'
import type { zGenerationOut } from '@/shared/api/generated/zod.gen'
import { useWorkspaceFiles } from '@/shared/workbench'
import { isRunningStatus } from './shots'

export type GenerationJob = z.infer<typeof zGenerationOut>

const PAGE_LIMIT = 100

const POLL_MS = 5000

export const storyboardQueryKeys = {
  frameCandidates: (conversationId: string) =>
    ['conversations', conversationId, 'workspace', 'frame-candidates'] as const,
  generations: (conversationId: string) => ['generations', { conversationId }] as const,
}

/** 服务端未推送生成进度；存在运行任务时每 5 秒轮询，全部结束后停止。 */
export const generationsRefetchInterval = (items: readonly { status: string }[]): number | false =>
  items.some((item) => isRunningStatus(item.status)) ? POLL_MS : false

export const useShotGenerations = (conversationId: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(
        `/generations?conversationId=${conversationId}&limit=${PAGE_LIMIT}`,
        zGenerationsPageOut,
        { fallbackErrorMessage: '读取生成任务失败', signal },
      ),
    queryKey: storyboardQueryKeys.generations(conversationId),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

/** 画幅取自生成合同，提交前检查以避免 422。 */
export const VIDEO_ASPECT_RATIOS: readonly string[] = zVideoGenerationIn.shape.aspectRatio.options

export interface VideoGenerationInput {
  conversationId: string
  shotIndex: number
  prompt: string
  imageUrls: readonly string[]
  seconds: number
  aspectRatio: string
}

/** 生成不带幂等键（ADR-0009 决策 4）；同组重复提交会创建多条任务。 */
export const submitVideoGeneration = async (
  input: VideoGenerationInput,
): Promise<GenerationJob> => {
  const envelope = await apiFetch('/generations', zGenerationEnvelope, {
    body: {
      aspectRatio: input.aspectRatio,
      conversationId: input.conversationId,
      durationSeconds: input.seconds,
      imageUrls: input.imageUrls,
      kind: 'video',
      prompt: input.prompt,
      shotIndex: input.shotIndex,
    },
    fallbackErrorMessage: '出片没发出去',
    method: 'POST',
  })
  return envelope.generation
}

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

export const uploadFrameImage = async (file: File): Promise<string> => {
  const ticket = await apiFetch('/uploads/sign', zUploadTicketOut, {
    body: { contentType: file.type, height: null, width: null },
    fallbackErrorMessage: '上传失败',
    method: 'POST',
  })
  const response = await fetch(ticket.upload.url, {
    body: file,
    headers: ticket.upload.headers,
    method: ticket.upload.method,
  })
  if (!response.ok) throw new Error(`上传失败：${response.status}`)
  const envelope = await apiFetch(`/assets/${ticket.assetId}`, zAssetEnvelope, {
    fallbackErrorMessage: '上传失败',
    method: 'POST',
  })
  return envelope.asset.url
}
