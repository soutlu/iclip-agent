import { z } from 'zod'
import type {
  CreateVideoTaskInput,
  ProductInfo,
  VideoTask,
  VideoTaskBriefFields,
  VideoTaskSnapshot,
} from '@/features/tasks/video-task.types'
import {
  importInspirationVideos,
  importWebInspirationVideos,
} from '@/features/tasks/api/inspiration.api'
import { apiFetch } from '@/shared/api/client'
import { uploadAndRegisterAsset } from '@/shared/lib/file-upload'

const videoTaskStatusSchema = z.enum(['confirmed', 'draft', 'published', 'withdrawn'])
const MIN_DURATION_SECONDS = 3
const MAX_DURATION_SECONDS = 50
const DURATION_ERROR_MESSAGE = '时长必须是 3–50 秒的整数'

const videoTaskBriefSchema = z
  .object({
    theme: z.string().optional(),
    purpose: z.string().optional(),
    audience: z.string().optional(),
    selling: z.string().optional(),
    scene: z.string().optional(),
    department: z.string().optional(),
    videoType: z.string().optional(),
    durationSeconds: z
      .number()
      .int()
      .min(MIN_DURATION_SECONDS)
      .max(MAX_DURATION_SECONDS)
      .optional(),
    ratio: z.string().optional(),
    language: z.string().optional(),
    platform: z.string().optional(),
    color: z.string().optional(),
    contentType: z.string().optional(),
    requester: z.string().optional(),
    requirementDescription: z.string().optional(),
    styleNos: z.array(z.string()).optional(),
    referenceImages: z.array(z.string()),
    referenceVideos: z.array(z.string()),
  })
  .strict()

const videoTaskSchema = z.object({
  brief: videoTaskBriefSchema,
  createdAt: z.string().nullable(),
  deadline: z.string().nullable(),
  id: z.string().min(1),
  priority: z.number(),
  schemaVersion: z.number().int(),
  status: videoTaskStatusSchema,
  style: z.object({
    brand: z.string(),
    category: z.string(),
    previewImageUrl: z.string().url(),
    styleNo: z.string(),
  }),
  title: z.string(),
  updatedAt: z.string().nullable(),
})

const videoTaskResponseSchema = z.object({ task: videoTaskSchema })
const videoTasksResponseSchema = z.object({ tasks: z.array(videoTaskSchema) })
const productInfoSchema = z.object({
  brand: z.string(),
  category: z.string(),
  colors: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  images: z.array(
    z.object({
      color: z.string().nullable(),
      id: z.string().min(1),
      url: z.string().url(),
    }),
  ),
  styleNo: z.string().min(1),
})
const productInfoResponseSchema = z.object({ product: productInfoSchema })

const videoTaskAssetSchema = z.object({
  assetType: z.enum(['audio', 'image', 'video']),
  id: z.string().min(1),
  mimeType: z.string().nullable(),
  url: z.string().url(),
})

const videoTaskAssetsResponseSchema = z.object({ assets: z.array(videoTaskAssetSchema) })

export const VIDEO_TASKS_QUERY_KEY = ['video-tasks'] as const

/**
 * 规范化可选 Brief 文本并保留数字型生成参数。
 *
 * @param brief - 创建任务表单中的概述与关键元素。
 * @returns 可直接写入 Video Task API 的 Brief 对象。
 */
const BRIEF_FIELD_ORDER = [
  'theme',
  'purpose',
  'audience',
  'selling',
  'scene',
  'department',
  'videoType',
  'durationSeconds',
  'ratio',
  'language',
  'platform',
  'color',
  'contentType',
  'requester',
  'requirementDescription',
] as const satisfies readonly (keyof VideoTaskBriefFields)[]

const createBriefPayload = (
  brief: VideoTaskBriefFields,
): Record<string, number | string | string[]> => {
  const durationSeconds = brief.durationSeconds
  if (
    durationSeconds !== undefined &&
    (!Number.isInteger(durationSeconds) ||
      durationSeconds < MIN_DURATION_SECONDS ||
      durationSeconds > MAX_DURATION_SECONDS)
  ) {
    throw new Error(DURATION_ERROR_MESSAGE)
  }

  const payload: Record<string, number | string | string[]> = Object.fromEntries(
    BRIEF_FIELD_ORDER.map((key) => [key, brief[key]] as const)
      .map(([key, value]): null | readonly [string, number | string] => {
        if (typeof value === 'number') {
          return [key, value]
        }

        const normalizedValue = value?.trim()
        return normalizedValue ? [key, normalizedValue] : null
      })
      .filter((entry): entry is readonly [string, number | string] => entry !== null),
  )

  const styleNos = (brief.styleNos ?? []).map((styleNo) => styleNo.trim()).filter(Boolean)
  if (styleNos.length > 0) {
    payload.styleNos = Array.from(new Set(styleNos))
  }
  return payload
}

const createDeadlineIso = (value: string) => {
  if (!value) {
    return null
  }

  return new Date(`${value}T23:59:59`).toISOString()
}

const taskAssetIds = (task: VideoTask) => [
  ...task.brief.referenceImages,
  ...task.brief.referenceVideos,
]

/**
 * 读取一组 Task 引用的全局素材并组成统一快照。
 *
 * @param tasks - 需要解析素材的 Task。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消素材请求的 AbortSignal。
 * @returns Task 与按素材 ID 建立的索引。
 */
const resolveVideoTaskSnapshot = async (
  tasks: VideoTask[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<VideoTaskSnapshot> => {
  const assetIds = Array.from(new Set(tasks.flatMap(taskAssetIds)))

  if (assetIds.length === 0) {
    return { assetsById: {}, tasks }
  }

  const search = new URLSearchParams()
  for (const assetId of assetIds) {
    search.append('assetId', assetId)
  }
  const { assets } = await apiFetch(`/assets?${search.toString()}`, videoTaskAssetsResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '加载任务素材失败',
    signal,
  })

  return {
    assetsById: Object.fromEntries(assets.map((asset) => [asset.id, asset])),
    tasks,
  }
}

export const listVideoTaskSnapshot = async ({
  signal,
}: { signal?: AbortSignal } = {}): Promise<VideoTaskSnapshot> => {
  const { tasks } = await apiFetch('/video-tasks', videoTasksResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '加载任务失败',
    signal,
  })

  return resolveVideoTaskSnapshot(tasks, { signal })
}

const importProductImagesResponseSchema = z.object({
  assets: z.array(
    z.object({
      assetId: z.string().min(1),
      imageId: z.string().min(1),
      url: z.string().url(),
    }),
  ),
})

type ImportedProductImageAsset = z.infer<typeof importProductImagesResponseSchema>['assets'][number]

/**
 * 把策划师选中的产品图一批处理成参考图素材：后端按需转存 OSS 并登记 import Asset。
 *
 * 产品图数量可能非常大，浏览用源地址、只有选中图才转存；形态与上传图片一致
 * （内容进 OSS → 登记 Asset），前端拿回 Asset id 直接进 referenceImages。
 *
 * @param input - Style 号与选中的产品图 id。
 * @param input.imageIds - 选中的产品图 id（少量）。
 * @param input.styleNo - 产品 Style 号。
 * @returns 与请求顺序一致的素材登记结果。
 */
const importProductImages = async ({
  imageIds,
  styleNo,
}: {
  imageIds: string[]
  styleNo: string
}): Promise<ImportedProductImageAsset[]> =>
  (
    await apiFetch('/video-tasks/product-images/import', importProductImagesResponseSchema, {
      body: { imageIds, styleNo },
      fallbackErrorMessage: '产品图转存失败',
      method: 'POST',
    })
  ).assets

/**
 * 按完整 Style 号精确读取 PDM 产品信息，不创建 Task。
 */
export const getProductInfo = async (
  styleNo: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProductInfo> => {
  const search = new URLSearchParams({ styleNo: styleNo.trim() })
  const { product } = await apiFetch(
    `/video-tasks/product-info?${search.toString()}`,
    productInfoResponseSchema,
    {
      cache: 'no-store',
      fallbackErrorMessage: '读取产品信息失败',
      signal,
    },
  )

  return product
}

/**
 * 上传用户参考素材，并用完整输入原子地创建 Task。
 *
 * @param input - 款号、Brief、用户上传的参考图和参考视频。
 * @returns 后端保存后的 Task。
 */
export const createVideoTask = async ({
  brief,
  deadline,
  referenceImages,
  referenceVideos,
  styleNo,
}: CreateVideoTaskInput): Promise<VideoTask> => {
  const normalizedStyleNo = styleNo.trim()
  const briefPayload = createBriefPayload(brief)
  const [imageAssets, videoAssets] = await Promise.all([
    Promise.all(referenceImages.map((file) => uploadAndRegisterAsset(file))),
    Promise.all(referenceVideos.map((file) => uploadAndRegisterAsset(file))),
  ])
  return (
    await apiFetch('/video-tasks', videoTaskResponseSchema, {
      body: {
        brief: {
          ...briefPayload,
          referenceImages: imageAssets.map((asset) => asset.id),
          referenceVideos: videoAssets.map((asset) => asset.id),
        },
        deadline: createDeadlineIso(deadline),
        styleNo: normalizedStyleNo,
      },
      fallbackErrorMessage: '创建任务失败',
      method: 'POST',
    })
  ).task
}

/** 策划师确认 Task 时补充的 Brief 字段与最终参考素材清单。 */
export type VideoTaskConfirmationInput = {
  /** 从首个参考视频元数据提取并四舍五入的时长。 */
  durationSeconds?: number
  /** 按用户选择顺序保存的爆款库与联网候选；保存时分别按需转存。 */
  inspirationVideos: (
    { source: 'library'; videoId: string } | { selectionToken: string; source: 'web' }
  )[]
  /** 保留的既有参考图 Asset（id + url，url 用于与新选产品图去重）。 */
  keptImageAssets: { id: string; url: string }[]
  /** 新上传的图片文件。 */
  newImageFiles: File[]
  /** 新上传的视频文件。 */
  newVideoFiles: File[]
  /** 本次新选中的产品图（按 Style 分组，一批转存并登记）。 */
  productImagePicks: { imageIds: string[]; styleNo: string }[]
  /** 确认阶段可调整的成片比例。 */
  ratio: string
  /** 确认阶段补入旁白后的完整需求描述 HTML。 */
  requirementDescription: string
  /** 无需转存的既有参考视频 Asset id。 */
  videoAssetIds: string[]
}

/**
 * 保存策划师补充的确认信息与参考素材：上传、产品图批量登记与推荐视频登记并行完成后
 * 整单 PUT 回任务。
 *
 * 后端在 published/confirmed 状态只允许 requirementDescription、durationSeconds、
 * ratio、referenceImages、referenceVideos（连同管理信息）变化，其余 brief 字段原样回传。
 *
 * @param task - 当前任务（提供回传所需的完整字段）。
 * @param input - 整理后的参考素材清单。
 * @returns 保存后的任务。
 */
export const updateVideoTaskConfirmation = async (
  task: VideoTask,
  input: VideoTaskConfirmationInput,
): Promise<VideoTask> => {
  if (
    input.durationSeconds !== undefined &&
    (!Number.isInteger(input.durationSeconds) ||
      input.durationSeconds < MIN_DURATION_SECONDS ||
      input.durationSeconds > MAX_DURATION_SECONDS)
  ) {
    throw new Error(DURATION_ERROR_MESSAGE)
  }

  const inspirationVideoIds = input.inspirationVideos.flatMap((video) =>
    video.source === 'library' ? [video.videoId] : [],
  )
  const webInspirationSelectionTokens = input.inspirationVideos.flatMap((video) =>
    video.source === 'web' ? [video.selectionToken] : [],
  )
  const [uploadedImages, uploadedVideos, importedVideos, importedWebVideos, importedProductAssets] =
    await Promise.all([
      Promise.all(input.newImageFiles.map((file) => uploadAndRegisterAsset(file))),
      Promise.all(input.newVideoFiles.map((file) => uploadAndRegisterAsset(file))),
      // 与产品图侧一致：没有新选爆款视频时不发 `{ videoIds: [] }` 的转存请求。
      inspirationVideoIds.length > 0 ? importInspirationVideos(inspirationVideoIds) : [],
      webInspirationSelectionTokens.length > 0
        ? importWebInspirationVideos({
            selectionTokens: webInspirationSelectionTokens,
            taskId: task.id,
          })
        : [],
      Promise.all(input.productImagePicks.map((pick) => importProductImages(pick))).then((groups) =>
        groups.flat(),
      ),
    ])

  // 重复勾选已保存过的产品图会命中同一 OSS URL：按 URL 与保留项去重，不写重复引用。
  const keptImageUrls = new Set(input.keptImageAssets.map((asset) => asset.url))
  const productAssetIds = Array.from(
    new Set(
      importedProductAssets
        .filter((asset) => !keptImageUrls.has(asset.url))
        .map((asset) => asset.assetId),
    ),
  )
  const libraryAssetIdByVideoId = new Map(
    importedVideos.map((asset) => [asset.videoId, asset.assetId] as const),
  )
  const webAssetIdBySelectionToken = new Map(
    importedWebVideos.map((asset) => [asset.selectionToken, asset.assetId] as const),
  )
  const inspirationAssetIds = input.inspirationVideos.map((video) => {
    const assetId =
      video.source === 'library'
        ? libraryAssetIdByVideoId.get(video.videoId)
        : webAssetIdBySelectionToken.get(video.selectionToken)
    if (assetId === undefined) {
      throw new Error('参考视频转存结果与选择结果不一致')
    }
    return assetId
  })

  return (
    await apiFetch(`/video-tasks/${encodeURIComponent(task.id)}`, videoTaskResponseSchema, {
      body: {
        brief: {
          ...task.brief,
          durationSeconds: input.durationSeconds,
          ratio: input.ratio,
          referenceImages: [
            ...input.keptImageAssets.map((asset) => asset.id),
            ...productAssetIds,
            ...uploadedImages.map((asset) => asset.id),
          ],
          referenceVideos: Array.from(
            new Set([
              ...input.videoAssetIds,
              ...inspirationAssetIds,
              ...uploadedVideos.map((asset) => asset.id),
            ]),
          ),
          requirementDescription: input.requirementDescription,
        },
        deadline: task.deadline,
        priority: task.priority,
        schemaVersion: task.schemaVersion,
        style: task.style,
        title: task.title,
      },
      fallbackErrorMessage: '保存确认信息失败',
      method: 'PUT',
    })
  ).task
}

export const publishVideoTask = async (taskId: string): Promise<VideoTask> =>
  (
    await apiFetch(`/video-tasks/${encodeURIComponent(taskId)}/publish`, videoTaskResponseSchema, {
      fallbackErrorMessage: '发布任务失败',
      method: 'POST',
    })
  ).task

/**
 * 策划师确认一条已下发（published）的 Task。
 *
 * @param taskId - 待确认的 Task id。
 * @returns 确认后（confirmed）的 Task。
 */
export const confirmVideoTask = async (taskId: string): Promise<VideoTask> =>
  (
    await apiFetch(`/video-tasks/${encodeURIComponent(taskId)}/confirm`, videoTaskResponseSchema, {
      fallbackErrorMessage: '确认任务失败',
      method: 'POST',
    })
  ).task

/**
 * 下发一条 Task：先原子创建草稿，再立即发布给策划师确认。
 *
 * @param input - 与创建相同的完整输入（主 Style 取 brief.styleNos 首位）。
 * @returns 发布后（published）的 Task。
 */
export const dispatchVideoTask = async (input: CreateVideoTaskInput): Promise<VideoTask> => {
  const created = await createVideoTask(input)
  return publishVideoTask(created.id)
}
