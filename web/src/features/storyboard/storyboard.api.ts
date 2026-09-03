/**
 * 分镜工作台除文件之外要碰的接口：这段对话的生成任务、发一次出片、可选的候选帧、上传一张图当帧。
 * 文件那一份走 `shared/workbench`。
 */

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

/** 一次生成任务对外的样子，形状即合同。 */
export type GenerationJob = z.infer<typeof zGenerationOut>

/** 一段对话的镜头组不会有几百组，一次拿够，免得翻页把旧的那几条漏掉。 */
const PAGE_LIMIT = 100

/** 有任务在飞时多久问一次。出片是分钟级的事，5 秒够勤了。 */
const POLL_MS = 5000

export const storyboardQueryKeys = {
  frameCandidates: (conversationId: string) =>
    ['conversations', conversationId, 'workspace', 'frame-candidates'] as const,
  generations: (conversationId: string) => ['generations', { conversationId }] as const,
}

/**
 * 该不该再问一次生成任务：有一条还在飞就每 5 秒问，全落定了就停。
 *
 * 服务端没有出片进度的推送，状态圆点、记录抽屉与页头都指着这一路更新。
 *
 * @param items - 当前手上的任务列表。
 * @returns 轮询间隔，或 false（不轮询）。
 */
export const generationsRefetchInterval = (items: readonly { status: string }[]): number | false =>
  items.some((item) => isRunningStatus(item.status)) ? POLL_MS : false

/** 这段对话名下的生成任务，面板按 `shotIndex` 分组用。 */
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

/** 合同里视频认的那几档画幅。文档写的不在其中就不发请求，发了必定 422。 */
export const VIDEO_ASPECT_RATIOS: readonly string[] = zVideoGenerationIn.shape.aspectRatio.options

export interface VideoGenerationInput {
  conversationId: string
  /** 第几组。填了它这条任务才归得上组。 */
  shotIndex: number
  prompt: string
  imageUrls: readonly string[]
  seconds: number
  aspectRatio: string
}

/**
 * 给一个镜头组发一次出片。
 *
 * 不带幂等键（ADR-0009 决策 4）：同一组多按几次就是多条任务，界面在飞行中把按钮禁掉。
 *
 * @param input - 这一组当前的描述、帧与时长。
 * @returns 排上队的那条任务。
 */
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

/** 出帧工具留下的版记录：`frames/grids/<jobId>.json`，只认这两个字段。 */
const gridRecordSchema = z.object({
  frames: z.array(z.object({ no: z.string(), url: z.string() })),
})

const GRID_RECORDS_PREFIX = 'frames/grids/'

/** 一张可以当帧用的候选图：地址加一句标签。 */
export type FrameCandidate = { url: string; label: string }

const fileContentSchema = z.object({
  file: z.object({ content: z.string(), path: z.string(), version: z.int() }),
})

/**
 * 这段对话里 agent 生成过的全部帧，按版记录逐份读出来，同一地址只留一份。
 *
 * 候选来自工作区而不是 transcript：agent 结束很久以后这些记录仍在，面板照样能换帧。
 *
 * @param conversationId - 哪一段对话。
 * @returns 候选帧查询。
 */
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

/**
 * 上传一张图并登记成素材，返回它的公网地址。与聊天附件同一条路：签直传 → PUT 进桶 → 登记。
 *
 * @param file - 本地文件。
 * @returns 登记后的地址。
 */
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
