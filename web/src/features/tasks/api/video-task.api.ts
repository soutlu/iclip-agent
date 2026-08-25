/**
 * 创作需求单的接口层（后端合同见仓库根 `contract/conventions.md` §7 §8 §10）。
 *
 * 一条要点贯穿全文：**brief 里的参考素材存的是地址，不是素材 id**。本地文件先走直传
 * 换成地址，外部地址（产品图、爆款视频）先转存换成我们自己的地址——外链会烂。
 */

import { z } from 'zod'
import type {
  CreateVideoTaskInput,
  ProductInfo,
  VideoTask,
  VideoTaskAsset,
  VideoTaskBriefFields,
  VideoTaskSnapshot,
} from '@/features/tasks/video-task.types'
import { ApiError, apiFetch } from '@/shared/api/client'
import { importAssetFromUrl, uploadAndRegisterAsset } from '@/shared/lib/file-upload'

const videoTaskStatusSchema = z.enum(['confirmed', 'draft', 'published', 'withdrawn'])
const MIN_DURATION_SECONDS = 3
const MAX_DURATION_SECONDS = 50
const DURATION_ERROR_MESSAGE = '时长必须是 3–50 秒的整数'
/** 列表一次最多取多少条（后端上限）。 */
const LIST_LIMIT = 100
/** 参考图与参考视频各自的条数上限（后端上限）。 */
const MAX_REFERENCE_URLS = 16

/** 后端没填的可选文本给的是空字符串，可选数字与画幅给的是 null。 */
const optionalTextSchema = z.string().optional()
const absentAsUndefined = <T>(value: null | T | undefined) => value ?? undefined

const videoTaskBriefSchema = z
  .object({
    audience: optionalTextSchema,
    color: optionalTextSchema,
    contentType: optionalTextSchema,
    department: optionalTextSchema,
    durationSeconds: z.number().int().nullable().optional().transform(absentAsUndefined),
    language: optionalTextSchema,
    platform: optionalTextSchema,
    purpose: optionalTextSchema,
    ratio: z.string().nullable().optional().transform(absentAsUndefined),
    referenceImages: z.array(z.string()),
    referenceVideos: z.array(z.string()),
    requester: optionalTextSchema,
    requirementDescription: optionalTextSchema,
    scene: optionalTextSchema,
    selling: optionalTextSchema,
    styleNos: z.array(z.string()).optional(),
    theme: optionalTextSchema,
    videoType: optionalTextSchema,
  })
  .strict()

const videoTaskSchema = z.object({
  brief: videoTaskBriefSchema,
  createdAt: z.string(),
  creatorUserId: z.string(),
  deadline: z.string().nullable(),
  id: z.string().min(1),
  priority: z.number(),
  status: videoTaskStatusSchema,
  style: z.object({
    brand: z.string(),
    category: z.string(),
    /** 这个款没有产品图时是空字符串，不是错误——所以这里不按 URL 规则校验。 */
    previewImageUrl: z.string(),
    styleNo: z.string(),
  }),
  title: z.string(),
  updatedAt: z.string(),
})

const videoTaskResponseSchema = z.object({ task: videoTaskSchema })
const videoTasksResponseSchema = z.object({ items: z.array(videoTaskSchema) })

/** 产品资料只声明前端用到的字段；码一定有，名字可能是 null。 */
const productResponseSchema = z.object({
  product: z.object({
    brand: z.object({ code: z.string(), name: z.string().nullable() }),
    category: z.object({ code: z.string(), name: z.string().nullable() }),
    colors: z.array(z.object({ code: z.string(), name: z.string().nullable() })),
    images: z.array(z.object({ id: z.string().min(1), url: z.string().url() })),
    styleNo: z.string().min(1),
    /** 同一个款在 WMS 那边的编号。搜爆款视频要用它，和 `styleNo` 不通用。 */
    styleWms: z.string(),
  }),
})

export const VIDEO_TASKS_QUERY_KEY = ['video-tasks'] as const

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

/**
 * 规范化可选 Brief 文本并保留数字型生成参数。
 *
 * @param brief - 创建任务表单中的概述与关键元素。
 * @returns 可直接写入需求单接口的 Brief 对象。
 */
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

/**
 * 需求单的标题。
 *
 * 表单里没有「标题」这一栏而后端要求必填，所以按主题取；主题空着就退回主款号——列表里
 * 总得有个认得出来的名字。
 *
 * @param brief - 表单填的 Brief。
 * @param styleNo - 主款号。
 * @returns 提交用的标题。
 */
const taskTitleFrom = (brief: VideoTaskBriefFields, styleNo: string) =>
  brief.theme?.trim() || styleNo

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * 从地址的扩展名读出媒体类型。
 *
 * @param url - 素材地址。
 * @returns 认得出来的媒体类型，否则 null。
 */
const mimeTypeFromUrl = (url: string): null | string => {
  const path = URL.canParse(url) ? new URL(url).pathname : url
  const extension = path.split('.').at(-1)?.toLowerCase()
  return (extension === undefined ? null : MIME_TYPE_BY_EXTENSION[extension]) ?? null
}

/**
 * 按地址索引任务引用的参考素材。
 *
 * brief 里存的就是地址，所以这份索引的键是地址本身（`id` 与 `url` 同值）。图还是视频看
 * 它在哪个数组里；具体类型从扩展名读，读不出来是 null——认不出类型的素材本来就不该被
 * 下游当成图或视频用。
 *
 * @param tasks - 当前列表里的任务。
 * @returns 地址 → 素材。
 */
const indexTaskAssets = (tasks: VideoTask[]): Record<string, VideoTaskAsset> => {
  const assetsByUrl: Record<string, VideoTaskAsset> = {}

  for (const task of tasks) {
    const grouped = [
      ['image', task.brief.referenceImages],
      ['video', task.brief.referenceVideos],
    ] as const

    for (const [assetType, urls] of grouped) {
      for (const url of urls) {
        assetsByUrl[url] = { assetType, id: url, mimeType: mimeTypeFromUrl(url), url }
      }
    }
  }

  return assetsByUrl
}

export const listVideoTaskSnapshot = async ({
  signal,
}: { signal?: AbortSignal } = {}): Promise<VideoTaskSnapshot> => {
  const { items } = await apiFetch(`/tasks?limit=${LIST_LIMIT}`, videoTasksResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '加载任务失败',
    signal,
  })

  return { assetsById: indexTaskAssets(items), tasks: items }
}

const fetchProduct = (styleNo: string, { signal }: { signal?: AbortSignal }) =>
  apiFetch(`/products/${encodeURIComponent(styleNo.trim())}`, productResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取产品信息失败',
    signal,
  })

/**
 * 按完整款号精确读取产品资料，不创建任务。
 *
 * @param styleNo - PDM 款号。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消请求的 AbortSignal。
 * @returns 表单与产品图选择器用的产品资料。
 */
export const getProductInfo = async (
  styleNo: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProductInfo> => {
  const { product } = await fetchProduct(styleNo, { signal })

  return {
    // 名字来自服务端对照表，上游出新码时是 null；没名字就退回码，不自己猜。
    brand: product.brand.name ?? product.brand.code,
    category: product.category.name ?? product.category.code,
    colors: product.colors.map((color) => ({ id: color.code, name: color.name ?? color.code })),
    // 产品资料不说哪张图属于哪个颜色，所以「按颜色筛图」这一档在这里恒为空。
    images: product.images.map((image) => ({ color: null, id: image.id, url: image.url })),
    styleNo: product.styleNo,
  }
}

/**
 * 把一组 PDM 款号换成 WMS 编号。
 *
 * 需求单只记 PDM 款号，而爆款库按 WMS 编号存——两套编码不通用，所以搜爆款视频之前得
 * 先去产品资料里换一次。查不到的款直接落下，不因为一个款连累整次搜索。
 *
 * @param styleNos - PDM 款号。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消请求的 AbortSignal。
 * @returns 换到的 WMS 编号，去重后保持入参顺序。
 */
export const listStyleWmsCodes = async (
  styleNos: readonly string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<string[]> => {
  const resolved = await Promise.all(
    styleNos.map(async (styleNo) => {
      try {
        return (await fetchProduct(styleNo, { signal })).product.styleWms
      } catch (error) {
        // 这个款在产品资料里查不到就落下它；别的错（会话失效、请求被取消）照常往外抛。
        if (error instanceof ApiError && error.status === 404) {
          return ''
        }
        throw error
      }
    }),
  )

  return Array.from(new Set(resolved.filter(Boolean)))
}

/**
 * 上传用户参考素材，并用完整输入创建需求单。
 *
 * @param input - 款号、Brief、用户上传的参考图和参考视频。
 * @returns 后端保存后的需求单（草稿）。
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
  const [uploadedImages, uploadedVideos] = await Promise.all([
    Promise.all(referenceImages.map((file) => uploadAndRegisterAsset(file))),
    Promise.all(referenceVideos.map((file) => uploadAndRegisterAsset(file))),
  ])

  return (
    await apiFetch('/tasks', videoTaskResponseSchema, {
      body: {
        brief: {
          ...briefPayload,
          referenceImages: uploadedImages.map((asset) => asset.url),
          referenceVideos: uploadedVideos.map((asset) => asset.url),
        },
        deadline: createDeadlineIso(deadline),
        styleNo: normalizedStyleNo,
        title: taskTitleFrom(brief, normalizedStyleNo),
      },
      fallbackErrorMessage: '创建任务失败',
      method: 'POST',
    })
  ).task
}

/** 本次新选的一条爆款视频。 */
export type SelectedInspirationSource =
  { ossUrl: null | string; source: 'library' } | { source: 'web' }

/** 策划师确认需求单时补充的 Brief 字段与最终参考素材清单（全部是地址）。 */
export type VideoTaskConfirmationInput = {
  /** 从首个参考视频元数据提取并四舍五入的时长。 */
  durationSeconds?: number
  /** 本次新选的爆款视频，按用户选择顺序；保存时按源地址转存。 */
  inspirationVideos: SelectedInspirationSource[]
  /** 保留下来的既有参考图地址。 */
  keptImageUrls: string[]
  /** 保留下来的既有参考视频地址。 */
  keptVideoUrls: string[]
  /** 新上传的图片文件。 */
  newImageFiles: File[]
  /** 新上传的视频文件。 */
  newVideoFiles: File[]
  /** 本次新选中的产品图地址（转存后换成我们自己的地址）。 */
  productImageUrls: string[]
  /** 确认阶段可调整的成片比例。 */
  ratio: string
  /** 确认阶段补入旁白后的完整需求描述。 */
  requirementDescription: string
}

/**
 * 取一条新选爆款视频可以转存的源地址。
 *
 * 联网搜索那一路给不出来：候选只有平台页面地址，没有视频文件地址，而本仓后端没有「去
 * 平台下载」这件事。所以这里响亮失败，不静默丢掉用户的选择。
 *
 * @param video - 用户选中的一条爆款视频。
 * @returns 可转存的源地址。
 */
/**
 * 参考素材条数不能超上限。
 *
 * @param label - 用于报错的中文名（参考图 / 参考视频）。
 * @param count - 这一类最终会写进去多少条（去重前，按最坏情况数）。
 */
const assertReferenceCount = (label: string, count: number) => {
  if (count > MAX_REFERENCE_URLS) {
    throw new Error(`${label}最多 ${MAX_REFERENCE_URLS} 条，现在有 ${count} 条，先去掉几个。`)
  }
}

const inspirationSourceUrl = (video: SelectedInspirationSource) => {
  if (video.source === 'web') {
    throw new Error('联网搜索到的视频还不能保存进需求单，请改用库内爆款视频或上传文件。')
  }

  if (!video.ossUrl) {
    throw new Error('这条爆款视频没有可转存的视频地址，请选别的或上传文件。')
  }

  return video.ossUrl
}

/**
 * 保存策划师补充的确认信息与参考素材：上传、产品图与爆款视频转存并行完成后整单 PUT。
 *
 * PUT 是整体覆盖。下发之后后端只允许 `requirementDescription`、`durationSeconds`、
 * `ratio`、`referenceImages`、`referenceVideos` 连同管理信息变化，其余 brief 字段必须
 * 原样回传——所以这里从 `task.brief` 铺开再覆盖那几项，而不是自己拼一份。请求体里也不能
 * 带 `style`：款号快照创建后就冻结了，带上是 422。
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

  // 条数在动手转存之前先数一遍：后端超限返回的 detail 是一个数组，前端的错误提取只认
  // 字符串，撞上去只会显示一句「保存失败（422）」。
  assertReferenceCount(
    '参考图',
    input.keptImageUrls.length + input.productImageUrls.length + input.newImageFiles.length,
  )
  assertReferenceCount(
    '参考视频',
    input.keptVideoUrls.length + input.inspirationVideos.length + input.newVideoFiles.length,
  )

  const inspirationUrls = input.inspirationVideos.map(inspirationSourceUrl)
  const [uploadedImages, uploadedVideos, productImages, inspirationVideos] = await Promise.all([
    Promise.all(input.newImageFiles.map((file) => uploadAndRegisterAsset(file))),
    Promise.all(input.newVideoFiles.map((file) => uploadAndRegisterAsset(file))),
    Promise.all(input.productImageUrls.map((url) => importAssetFromUrl(url))),
    Promise.all(inspirationUrls.map((url) => importAssetFromUrl(url))),
  ])

  return (
    await apiFetch(`/tasks/${encodeURIComponent(task.id)}`, videoTaskResponseSchema, {
      body: {
        brief: {
          ...task.brief,
          durationSeconds: input.durationSeconds,
          ratio: input.ratio.trim() || null,
          // 同一张产品图重复勾选会转存成同一个地址，去重后不写重复引用。
          referenceImages: Array.from(
            new Set([
              ...input.keptImageUrls,
              ...productImages.map((asset) => asset.url),
              ...uploadedImages.map((asset) => asset.url),
            ]),
          ),
          referenceVideos: Array.from(
            new Set([
              ...input.keptVideoUrls,
              ...inspirationVideos.map((asset) => asset.url),
              ...uploadedVideos.map((asset) => asset.url),
            ]),
          ),
          requirementDescription: input.requirementDescription,
        },
        deadline: task.deadline,
        priority: task.priority,
        title: task.title,
      },
      fallbackErrorMessage: '保存确认信息失败',
      method: 'PUT',
    })
  ).task
}

export const publishVideoTask = async (taskId: string): Promise<VideoTask> =>
  (
    await apiFetch(`/tasks/${encodeURIComponent(taskId)}/publish`, videoTaskResponseSchema, {
      fallbackErrorMessage: '发布任务失败',
      method: 'POST',
    })
  ).task

/**
 * 策划师接下一条已下发的需求单。
 *
 * @param taskId - 待确认的任务 id。
 * @returns 确认后（confirmed）的任务。
 */
export const confirmVideoTask = async (taskId: string): Promise<VideoTask> =>
  (
    await apiFetch(`/tasks/${encodeURIComponent(taskId)}/confirm`, videoTaskResponseSchema, {
      fallbackErrorMessage: '确认任务失败',
      method: 'POST',
    })
  ).task

/**
 * 下发一条需求单：先建草稿，再立即发布给策划师确认。
 *
 * 不是原子操作：草稿建成而发布失败时那张草稿留在库里，用户能在列表里看到它。
 *
 * @param input - 与创建相同的完整输入。
 * @returns 发布后（published）的任务。
 */
export const dispatchVideoTask = async (input: CreateVideoTaskInput): Promise<VideoTask> => {
  const created = await createVideoTask(input)
  return publishVideoTask(created.id)
}
