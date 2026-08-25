import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'

/** 爆款库推荐视频的排序维度（服务端排序，直接决定 top-N 取样）。 */
export type InspirationSortKey = 'clicks' | 'impressions' | 'orders' | 'revenueAmount' | 'views'

export type InspirationMatchLevel = 'exact' | 'none' | 'sameBrandCategory' | 'sameCategory'

const inspirationVideoSchema = z.object({
  creatorHandle: z.string().nullable(),
  metrics: z.object({
    clicks: z.number(),
    impressions: z.number(),
    orders: z.number(),
    revenueAmount: z.string(),
    views: z.number(),
  }),
  ossUrl: z.string().min(1),
  postedDate: z.string().nullable(),
  styleNo: z.string(),
  videoId: z.string().min(1),
  videoUrl: z.string().nullable(),
})

const inspirationSearchResponseSchema = z.object({
  items: z.array(inspirationVideoSchema),
  matches: z.array(
    z.object({
      matchLevel: z.enum(['exact', 'none', 'sameBrandCategory', 'sameCategory']),
      styleNo: z.string(),
    }),
  ),
})

const webInspirationCandidateSchema = z.object({
  creatorHandle: z.string().nullable(),
  durationSeconds: z.number().positive().nullable(),
  platformVideoId: z.string().min(1),
  postUrl: z.string().url(),
  responsePosition: z.number().int().positive(),
  selectionToken: z.string().min(1),
  thumbnailUrl: z.string().url().nullable(),
  title: z.string().nullable(),
})

const webInspirationPlatformSchema = z.enum(['tiktok', 'instagram', 'youtube'])
const webInspirationSearchPlatformSchema = webInspirationPlatformSchema

const WEB_INSPIRATION_PLATFORM_LABELS: Record<WebInspirationSearchPlatform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
}

const webInspirationSearchResponseSchema = z.object({
  items: z.array(webInspirationCandidateSchema).max(10),
  platform: webInspirationSearchPlatformSchema,
  query: z.string().min(1),
  source: z.literal('web'),
})

const webInspirationMetricsSchema = z.object({
  commentCount: z.number().int().nonnegative().nullable(),
  likeCount: z.number().int().nonnegative().nullable(),
  shareCount: z.number().int().nonnegative().nullable(),
  viewCount: z.number().int().nonnegative().nullable(),
})

const webInspirationEnrichedItemSchema = z.object({
  durationSeconds: z.number().positive().nullable(),
  metrics: webInspirationMetricsSchema,
  platformVideoId: z.string().min(1),
  responsePosition: z.number().int().positive(),
  selectionToken: z.string().min(1),
  thumbnailUrl: z.string().url(),
})

const webInspirationEnrichResponseSchema = z.object({
  items: z.array(webInspirationEnrichedItemSchema).max(10),
  platform: webInspirationPlatformSchema,
  source: z.literal('web'),
})

export type InspirationVideo = z.infer<typeof inspirationVideoSchema>
export type WebInspirationCandidate = z.infer<typeof webInspirationCandidateSchema>
export type WebInspirationEnrichedItem = z.infer<typeof webInspirationEnrichedItemSchema>
export type WebInspirationMetrics = z.infer<typeof webInspirationMetricsSchema>
export type WebInspirationPlatform = z.infer<typeof webInspirationPlatformSchema>
export type WebInspirationSearchPlatform = z.infer<typeof webInspirationSearchPlatformSchema>
export type SelectedInspirationVideo =
  | (InspirationVideo & { source: 'library' })
  | (WebInspirationCandidate & {
      metrics?: WebInspirationMetrics
      platform: WebInspirationPlatform
      source: 'web'
    })

type InspirationVideoSearchResult = z.infer<typeof inspirationSearchResponseSchema>
export type WebInspirationSearchResult = z.infer<typeof webInspirationSearchResponseSchema>

export const inspirationVideoSelectionKey = (video: SelectedInspirationVideo) =>
  video.source === 'library'
    ? `tiktok:${video.videoId}`
    : `${video.platform}:${video.platformVideoId}`

/**
 * 按准确 Style 搜索爆款库参考视频（无同款时服务端按品牌/品类逐级回退）。
 *
 * @param input - Style 号集合与排序维度。
 * @param input.limit - 返回条数上限；返回条数小于它说明候选池已完整。
 * @param input.sortBy - 排序维度（曝光/播放/点击/成交/GMV）。
 * @param input.styleNos - 任务关联的 Style 号。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消的 AbortSignal。
 * @returns 推荐视频列表与每个 Style 的匹配层级。
 */
export const searchInspirationVideos = async (
  { limit, sortBy, styleNos }: { limit: number; sortBy: InspirationSortKey; styleNos: string[] },
  { signal }: { signal?: AbortSignal } = {},
): Promise<InspirationVideoSearchResult> =>
  apiFetch('/inspirations/videos/search', inspirationSearchResponseSchema, {
    body: { limit, sortBy, styleNos },
    fallbackErrorMessage: '加载推荐参考视频失败',
    method: 'POST',
    signal,
  })

/**
 * 用人工确认的品类、使用场景与可选卖点主动搜索一个平台。
 *
 * 响应只是可预览候选，不下载视频或登记 Asset。opaque selectionToken 只在用户保存
 * 创作材料时交给 web-import。调用方可并发请求 TikTok、Instagram 与 YouTube，独立处理完成和失败。
 */
export const searchWebInspirationVideos = async (
  input: {
    category: string
    platform: WebInspirationSearchPlatform
    scene: string
    sellingPoint?: string
    taskId: string
  },
  { signal }: { signal?: AbortSignal } = {},
): Promise<WebInspirationSearchResult> => {
  const result = await apiFetch(
    '/inspirations/videos/web-search',
    webInspirationSearchResponseSchema,
    {
      body: input,
      fallbackErrorMessage: `联网搜索${WEB_INSPIRATION_PLATFORM_LABELS[input.platform]}失败`,
      method: 'POST',
      signal,
    },
  )
  if (result.platform !== input.platform) {
    throw new Error('联网搜索响应平台与请求不一致')
  }
  return result
}

/**
 * 按搜索候选的 opaque token 批量补齐一个平台的封面、时长与互动指标。
 *
 * 请求不提交候选 URL；响应必须与搜索结果一一对应且顺序、身份完全一致，避免把
 * 详情错误地贴到另一条视频上。该调用只获取元数据，不下载视频或登记 Asset。
 */
export const enrichWebInspirationVideos = async (
  input: {
    candidates: readonly WebInspirationCandidate[]
    platform: WebInspirationSearchPlatform
    taskId: string
  },
  { signal }: { signal?: AbortSignal } = {},
): Promise<WebInspirationEnrichedItem[]> => {
  const selectionTokens = input.candidates.map((candidate) => candidate.selectionToken)
  const result = await apiFetch(
    '/inspirations/videos/web-enrich',
    webInspirationEnrichResponseSchema,
    {
      body: { platform: input.platform, selectionTokens, taskId: input.taskId },
      fallbackErrorMessage: `联网补全${WEB_INSPIRATION_PLATFORM_LABELS[input.platform]}详情失败`,
      method: 'POST',
      signal,
    },
  )
  const identitiesMatch =
    result.platform === input.platform &&
    result.items.length === input.candidates.length &&
    result.items.every((item, index) => {
      const candidate = input.candidates[index]
      return (
        candidate !== undefined &&
        item.selectionToken === candidate.selectionToken &&
        item.platformVideoId === candidate.platformVideoId &&
        item.responsePosition === candidate.responsePosition
      )
    }) &&
    new Set(result.items.map((item) => item.selectionToken)).size === result.items.length

  if (!identitiesMatch) {
    throw new Error(`联网补全${WEB_INSPIRATION_PLATFORM_LABELS[input.platform]}详情响应身份不一致`)
  }
  return result.items
}
