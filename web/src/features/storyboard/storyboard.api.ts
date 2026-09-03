/**
 * 分镜工作台除文件之外要碰的接口：这段对话的生成任务、可选的候选帧、上传一张图当帧。
 * 文件那一份走 `shared/workbench`。
 */

import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zAssetEnvelope,
  zGenerationsPageOut,
  zUploadTicketOut,
} from '@/shared/api/generated/zod.gen'
import type { zGenerationOut } from '@/shared/api/generated/zod.gen'
import { useWorkspaceFiles } from '@/shared/workbench'

/** 一次生成任务对外的样子，形状即合同。 */
export type GenerationJob = z.infer<typeof zGenerationOut>

/** 一段对话的镜头组不会有几百组，一次拿够，免得翻页把旧的那几条漏掉。 */
const PAGE_LIMIT = 100

export const storyboardQueryKeys = {
  frameCandidates: (conversationId: string) =>
    ['conversations', conversationId, 'workspace', 'frame-candidates'] as const,
  generations: (conversationId: string) => ['generations', { conversationId }] as const,
}

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
  })

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
