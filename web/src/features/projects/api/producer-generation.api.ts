import { z } from 'zod'
import type {
  ProducerGenerationInputRef,
  ProducerGenerationRequestPayload,
  SubmitVideoGenerationRequestInput,
} from '@/features/projects/producer-project.types'
import { apiFetch } from '@/shared/api/client'
import { optionalStringSchema, requiredStringSchema, wireRecordSchema } from '@/shared/api/schemas'

/** 可选时间戳字段：有限数字或字符串保留原值，其余容错归一为 null。 */
// zod v4 中 z.unknown().transform(...) 字段不允许键缺失，必须先 .optional() 再进 transform。
const optionalTimestampSchema = z
  .unknown()
  .optional()
  .transform((value) =>
    (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string'
      ? value
      : null,
  )

/**
 * 可空对象字段：null/缺失归一为 null，普通对象透传，其余值报错。
 *
 * @param field - 字段名，用于拼接错误文案。
 * @returns 校验后的对象或 null。
 */
const optionalRecordSchema = (field: string) =>
  z
    .union([z.null(), wireRecordSchema(`视频生成任务 ${field} 必须是对象`)], {
      error: `视频生成任务 ${field} 必须是对象`,
    })
    .optional()
    .transform((value) => value ?? null)

/** 后端 generation status → 前端任务状态。 */
const VIDEO_GENERATION_STATUS_MAP = {
  completed: 'succeeded',
  created: 'queued',
  failed: 'failed',
  submitted: 'running',
} as const

const generationStatusSchema = requiredStringSchema('视频生成任务缺少 status').refine(
  (value): value is keyof typeof VIDEO_GENERATION_STATUS_MAP =>
    value in VIDEO_GENERATION_STATUS_MAP,
  { error: (issue) => `视频生成任务 status 无效：${String(issue.input)}` },
)

const generationRequestPayloadSchema = wireRecordSchema('视频生成任务缺少 requestPayload')
  .refine(
    (payload) => typeof payload.type === 'string' && payload.type.trim().length > 0,
    '视频生成 requestPayload 缺少 type',
  )
  .transform((payload): ProducerGenerationRequestPayload => ({
    ...payload,
    type: payload.type as string,
  }))

const producerVideoGenerationTaskSchema = z
  .object(
    {
      assetType: requiredStringSchema('视频生成任务缺少 assetType'),
      completedAt: optionalTimestampSchema,
      createdAt: optionalTimestampSchema,
      errorCode: optionalStringSchema,
      errorMessage: optionalStringSchema,
      failedAt: optionalTimestampSchema,
      id: requiredStringSchema('视频生成任务缺少 id'),
      providerSnapshot: optionalRecordSchema('providerSnapshot'),
      providerStatus: optionalStringSchema,
      providerTaskId: optionalStringSchema,
      requestPayload: generationRequestPayloadSchema,
      status: generationStatusSchema,
      submittedAt: optionalTimestampSchema,
      updatedAt: optionalTimestampSchema,
    },
    { error: '视频生成提交响应缺少 generation' },
  )
  .transform((generation) => ({
    ...generation,
    rawStatus: generation.status,
    status: VIDEO_GENERATION_STATUS_MAP[generation.status],
  }))

/** 后端 `/video-generations` 提交响应 wire schema。 */
const producerVideoGenerationSubmissionSchema = z.object(
  { generation: producerVideoGenerationTaskSchema },
  { error: '视频生成提交响应格式无效' },
)

const producerAssetsResponseSchema = z.object(
  {
    assets: z.array(wireRecordSchema('Producer asset 响应格式无效'), {
      error: 'Producer assets 响应格式无效',
    }),
  },
  { error: 'Producer assets 响应格式无效' },
)

const producerGenerationsResponseSchema = z.object(
  {
    generations: z.array(wireRecordSchema('Producer generation 响应格式无效'), {
      error: 'Producer generations 响应格式无效',
    }),
  },
  { error: 'Producer generations 响应格式无效' },
)

export type VideoGenerationScope =
  { projectId: string; type: 'project' } | { sessionId: string; type: 'session' }

/**
 * 把提交输入转换为后端视频生成请求体。
 *
 * @param scope - 统一提交入口需要的 project/session 作用域。
 * @param input - 前端视频生成命令。
 * @returns 后端 video-generations 接收的请求体。
 */
export const createVideoGenerationRequestPayload = (
  scope: VideoGenerationScope,
  input: SubmitVideoGenerationRequestInput,
) => ({
  assetType: 'video',
  requestPayload: {
    inputs: [
      ...input.referenceImages.map((url): ProducerGenerationInputRef => ({
        kind: 'url',
        mediaType: 'image',
        url,
      })),
      ...input.referenceVideos.map((url): ProducerGenerationInputRef => ({
        kind: 'url',
        mediaType: 'video',
        url,
      })),
      ...input.referenceAudios.map((url): ProducerGenerationInputRef => ({
        kind: 'url',
        mediaType: 'audio',
        url,
      })),
    ],
    model: input.model,
    params: {
      aspectRatio: input.aspectRatio,
      durationSeconds: input.seconds,
      shotIndex: input.shotIndex,
    },
    prompt: input.prompt,
    type: 'video',
  },
  scope,
})

/**
 * 将已准备好的附件 URL 拆成视频生成 reference 字段。
 *
 * @param fileParts - 已上传或已存在远端 URL 的附件。
 * @returns 后端 video-generations request 使用的 reference URL 分组。
 */
export const splitVideoGenerationReferenceUrls = (
  fileParts: Array<{ mediaType: string; url: string }>,
): Pick<
  SubmitVideoGenerationRequestInput,
  'referenceAudios' | 'referenceImages' | 'referenceVideos'
> => {
  const referenceAudios: string[] = []
  const referenceImages: string[] = []
  const referenceVideos: string[] = []

  for (const filePart of fileParts) {
    if (filePart.mediaType.startsWith('image/')) {
      referenceImages.push(filePart.url)
      continue
    }

    if (filePart.mediaType.startsWith('video/')) {
      referenceVideos.push(filePart.url)
      continue
    }

    if (filePart.mediaType.startsWith('audio/')) {
      referenceAudios.push(filePart.url)
      continue
    }

    throw new Error(`视频生成参考素材仅支持图片、视频、音频：${filePart.mediaType}`)
  }

  return {
    referenceAudios,
    referenceImages,
    referenceVideos,
  }
}

/**
 * 读取项目文件夹下已经登记的素材事实。
 *
 * @param projectId - 项目文件夹 id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端 media_assets 原始记录。
 */
export const listProducerProjectAssets = async (
  projectId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/projects/${encodeURIComponent(projectId)}/assets`,
      producerAssetsResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载项目素材失败',
        signal,
      },
    )
  ).assets

/**
 * 读取 session 下已经登记的素材事实。
 *
 * @param sessionId - Agno session id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端 media_assets 原始记录。
 */
export const listProducerSessionAssets = async (
  sessionId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/sessions/${encodeURIComponent(sessionId)}/assets`,
      producerAssetsResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载 session 素材失败',
        signal,
      },
    )
  ).assets

/**
 * 读取项目文件夹下已经持久化的 generation job 事实。
 *
 * @param projectId - 项目文件夹 id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端 generation_jobs 原始 wire records。
 */
export const listProducerProjectGenerations = async (
  projectId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/projects/${encodeURIComponent(projectId)}/generations`,
      producerGenerationsResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载项目 generation 失败',
        signal,
      },
    )
  ).generations

/**
 * 读取 session 下已经持久化的 generation job 事实。
 *
 * @param sessionId - Agno session id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端 generation_jobs 原始 wire records。
 */
export const listProducerSessionGenerations = async (
  sessionId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/sessions/${encodeURIComponent(sessionId)}/generations`,
      producerGenerationsResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载 session generation 失败',
        signal,
      },
    )
  ).generations

/**
 * 提交当前 direct 项目文件夹的视频生成任务。
 *
 * @param projectId - 项目文件夹 id。
 * @param input - 视频生成请求输入。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端创建的视频生成任务。
 */
export const submitProjectVideoGeneration = async (
  projectId: string,
  input: SubmitVideoGenerationRequestInput,
  { signal }: { signal?: AbortSignal } = {},
) =>
  apiFetch('/video-generations', producerVideoGenerationSubmissionSchema, {
    body: createVideoGenerationRequestPayload({ projectId, type: 'project' }, input),
    cache: 'no-store',
    fallbackErrorMessage: '提交视频生成任务失败',
    method: 'POST',
    signal,
  })

/**
 * 提交当前 agent session 的视频生成任务。
 *
 * @param sessionId - Agno session id。
 * @param input - 视频生成请求输入。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端创建的视频生成任务。
 */
export const submitSessionVideoGeneration = async (
  sessionId: string,
  input: SubmitVideoGenerationRequestInput,
  { signal }: { signal?: AbortSignal } = {},
) =>
  apiFetch('/video-generations', producerVideoGenerationSubmissionSchema, {
    body: createVideoGenerationRequestPayload({ sessionId, type: 'session' }, input),
    cache: 'no-store',
    fallbackErrorMessage: '提交视频生成任务失败',
    method: 'POST',
    signal,
  })
