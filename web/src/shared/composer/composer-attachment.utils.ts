import type {
  ComposerFileAttachment,
  MediaComposerMessagePart,
} from '@/shared/composer/composer.types'
import { uploadAndRegisterAsset } from '@/shared/lib/file-upload'
import { createOpaqueIdSuffix } from '@/shared/lib/opaque-id'

export interface ComposerMediaNameSeed {
  [key: string]: unknown
  kind: ComposerFileAttachment['kind']
  name: string
}

export interface ComposerFilePart {
  filename?: string
  mediaType: string
  type: 'file'
  url: string
}

const FILE_EXTENSION_MEDIA_TYPE = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  png: 'image/png',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
} as const satisfies Record<string, string>

const BLOB_URL_PREFIX = 'blob:'
const AUDIO_ATTACHMENT_NAME_PATTERN = /^audio_(\d+)$/u
const IMAGE_ATTACHMENT_NAME_PATTERN = /^image_(\d+)$/u
const VIDEO_ATTACHMENT_NAME_PATTERN = /^video_(\d+)$/u

export const COMPOSER_MEDIA_FILE_ACCEPT = 'image/*,video/*,audio/*'
export const COMPOSER_MEDIA_LIMITS = {
  audio: 3,
  image: 9,
  video: 3,
} as const satisfies Record<ComposerFileAttachment['kind'], number>
export const COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE =
  '图片最多上传 9 张，视频最多 3 个，音频最多 3 个。'

export interface ComposerFileIngressResult {
  attachments: ComposerFileAttachment[]
  errors: string[]
}

interface CreateComposerAttachmentsFromFilesOptions {
  getAttachmentName?: (file: File, mediaType: string) => string
}

export interface PreparedComposerAttachmentsForSubmission {
  fileParts: ComposerFilePart[]
  remoteAttachments: ComposerFileAttachment[]
}

export interface ComposerMediaNameSequences {
  nextAudioSequence: number
  nextImageSequence: number
  nextVideoSequence: number
}

export interface ComposerMediaAttachmentCounts {
  audio: number
  image: number
  video: number
}

interface ComposerAttachmentLimitPartition {
  acceptedAttachments: ComposerFileAttachment[]
  rejectedAttachments: ComposerFileAttachment[]
}

const createComposerAttachmentDisplayName = (
  kind: ComposerFileAttachment['kind'],
  sequence: number,
) => {
  switch (kind) {
    case 'audio':
      return `audio_${sequence}`
    case 'image':
      return `image_${sequence}`
    case 'video':
      return `video_${sequence}`
    default:
      throw new Error(`未知附件类型：${String(kind)}`)
  }
}

const VIDEO_THUMBNAIL_EVENT_TIMEOUT_MS = 1500
const VIDEO_THUMBNAIL_CAPTURE_TIME_SECONDS = 0.2

const waitForVideoFrame = (
  video: HTMLVideoElement,
  eventName: 'loadeddata' | 'loadedmetadata' | 'seeked',
) =>
  new Promise<void>((resolve, reject) => {
    const readyStateSatisfied =
      (eventName === 'loadedmetadata' && video.readyState >= HTMLMediaElement.HAVE_METADATA) ||
      ((eventName === 'loadeddata' || eventName === 'seeked') &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)

    if (readyStateSatisfied) {
      resolve()
      return
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error(`${eventName} timeout`))
    }, VIDEO_THUMBNAIL_EVENT_TIMEOUT_MS)

    const cleanup = () => {
      window.clearTimeout(timeoutId)
      video.removeEventListener(eventName, handleResolve)
      video.removeEventListener('error', handleError)
    }

    const handleResolve = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error(`${eventName} error`))
    }

    video.addEventListener(eventName, handleResolve, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })

const createVideoThumbnailDataUrl = async (previewUrl: string) => {
  if (
    typeof document === 'undefined' ||
    typeof HTMLCanvasElement === 'undefined' ||
    typeof HTMLVideoElement === 'undefined'
  ) {
    return undefined
  }

  const canvas = document.createElement('canvas')
  let context: CanvasRenderingContext2D | null

  try {
    context = canvas.getContext('2d')
  } catch {
    return undefined
  }

  if (!context) {
    return undefined
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  video.src = previewUrl

  try {
    await waitForVideoFrame(video, 'loadedmetadata')

    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      return undefined
    }

    const duration = Number.isFinite(video.duration) ? Math.max(video.duration, 0) : 0
    const captureTime = Math.min(VIDEO_THUMBNAIL_CAPTURE_TIME_SECONDS, Math.max(duration - 0.05, 0))

    if (captureTime > 0) {
      video.currentTime = captureTime
      await waitForVideoFrame(video, 'seeked')
    }

    await waitForVideoFrame(video, 'loadeddata')

    const maxWidth = 160
    const scale = Math.min(1, maxWidth / video.videoWidth)
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.72)
  } catch {
    return undefined
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}

const createAttachmentId = (name: string) => {
  return `attachment-${name}-${createOpaqueIdSuffix(8)}`
}

const getNormalizedExtension = (value: string) => {
  const pathname = value.split('?')[0]?.split('#')[0] ?? value
  const segments = pathname.split('.')
  const extension = segments.at(-1)?.trim().toLowerCase()

  return extension && extension !== pathname ? extension : undefined
}

const normalizeMediaType = (value: string | undefined) => {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalizedValue = value.split(';')[0]?.trim().toLowerCase()
  return normalizedValue || undefined
}

const resolveAttachmentAbsoluteUrl = (url: string) => {
  try {
    return new URL(url).toString()
  } catch {
    // noop: fall back to current origin resolution for relative urls
  }

  if (typeof globalThis.location?.origin !== 'string') {
    throw new Error('当前环境无法解析附件资源地址。')
  }

  return new URL(url, globalThis.location.origin).toString()
}

const formatAttachmentNames = (names: string[]) => names.slice(0, 3).join('、')

const createUnsupportedAttachmentError = (name: string) => `暂不支持该附件类型：${name}`
const resolveLocalFileMediaType = (file: File) =>
  inferMediaTypeFromName(file.name) ?? normalizeMediaType(file.type)

export const getComposerAttachmentKindFromMediaType = (
  mediaType: string,
): ComposerFileAttachment['kind'] => {
  if (mediaType.startsWith('audio/')) {
    return 'audio'
  }

  if (mediaType.startsWith('image/')) {
    return 'image'
  }

  if (mediaType.startsWith('video/')) {
    return 'video'
  }

  throw new Error(`暂不支持该附件类型：${mediaType}`)
}

const isMediaAttachmentSupported = (mediaType: string | undefined): mediaType is string =>
  typeof mediaType === 'string' &&
  (mediaType.startsWith('audio/') ||
    mediaType.startsWith('image/') ||
    mediaType.startsWith('video/'))

const createLocalAttachmentFromFile = async (
  file: File,
  mediaType: string,
  displayName: string,
): Promise<ComposerFileAttachment> => {
  if (typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new Error('当前环境不支持创建本地媒体预览。')
  }

  const previewUrl = globalThis.URL.createObjectURL(file)
  const kind = getComposerAttachmentKindFromMediaType(mediaType)

  return {
    delivery: 'local',
    file,
    id: createAttachmentId(file.name),
    kind,
    mediaType,
    name: displayName,
    thumbnailUrl: kind === 'video' ? await createVideoThumbnailDataUrl(previewUrl) : undefined,
    url: previewUrl,
  }
}

const processLocalFile = async (
  file: File,
  options: CreateComposerAttachmentsFromFilesOptions = {},
): Promise<ComposerFileAttachment> => {
  const mediaType = resolveLocalFileMediaType(file)

  if (isMediaAttachmentSupported(mediaType)) {
    return createLocalAttachmentFromFile(
      file,
      mediaType,
      options.getAttachmentName?.(file, mediaType) ?? file.name,
    )
  }

  throw new Error(createUnsupportedAttachmentError(file.name))
}

const inferMediaTypeFromName = (value: string) => {
  const extension = getNormalizedExtension(value)

  if (!extension || !(extension in FILE_EXTENSION_MEDIA_TYPE)) {
    return undefined
  }

  return FILE_EXTENSION_MEDIA_TYPE[extension as keyof typeof FILE_EXTENSION_MEDIA_TYPE]
}

const isBlobUrl = (value: string) => value.startsWith(BLOB_URL_PREFIX)

export const isLocalAttachment = (
  attachment: ComposerFileAttachment,
): attachment is ComposerFileAttachment & { delivery: 'local'; file: File; url: string } =>
  attachment.delivery === 'local' &&
  typeof File !== 'undefined' &&
  attachment.file instanceof File &&
  typeof attachment.url === 'string' &&
  attachment.url.trim().length > 0

export const deriveNextComposerMediaNameSequences = (
  attachments: ComposerMediaNameSeed[],
): ComposerMediaNameSequences => {
  let nextAudioSequence = 1
  let nextImageSequence = 1
  let nextVideoSequence = 1

  for (const attachment of attachments) {
    if (attachment.kind === 'audio') {
      const matchedSequence = attachment.name.match(AUDIO_ATTACHMENT_NAME_PATTERN)?.[1]
      const parsedSequence = matchedSequence ? Number.parseInt(matchedSequence, 10) : Number.NaN

      if (Number.isFinite(parsedSequence)) {
        nextAudioSequence = Math.max(nextAudioSequence, parsedSequence + 1)
      }

      continue
    }

    if (attachment.kind === 'image') {
      const matchedSequence = attachment.name.match(IMAGE_ATTACHMENT_NAME_PATTERN)?.[1]
      const parsedSequence = matchedSequence ? Number.parseInt(matchedSequence, 10) : Number.NaN

      if (Number.isFinite(parsedSequence)) {
        nextImageSequence = Math.max(nextImageSequence, parsedSequence + 1)
      }

      continue
    }

    const matchedSequence = attachment.name.match(VIDEO_ATTACHMENT_NAME_PATTERN)?.[1]
    const parsedSequence = matchedSequence ? Number.parseInt(matchedSequence, 10) : Number.NaN

    if (Number.isFinite(parsedSequence)) {
      nextVideoSequence = Math.max(nextVideoSequence, parsedSequence + 1)
    }
  }

  return {
    nextAudioSequence,
    nextImageSequence,
    nextVideoSequence,
  }
}

export const normalizeComposerAttachmentNamesByOrder = (
  attachments: ComposerFileAttachment[],
  mediaNameSeeds: ComposerMediaNameSeed[] = [],
) => {
  let { nextAudioSequence, nextImageSequence, nextVideoSequence } =
    deriveNextComposerMediaNameSequences(mediaNameSeeds)
  let hasChanges = false

  const normalizedAttachments = attachments.map((attachment) => {
    const nextName = createComposerAttachmentDisplayName(
      attachment.kind,
      attachment.kind === 'audio'
        ? nextAudioSequence
        : attachment.kind === 'image'
          ? nextImageSequence
          : nextVideoSequence,
    )

    if (attachment.kind === 'audio') {
      nextAudioSequence += 1
    }

    if (attachment.kind === 'image') {
      nextImageSequence += 1
    }

    if (attachment.kind === 'video') {
      nextVideoSequence += 1
    }

    if (attachment.name === nextName) {
      return attachment
    }

    hasChanges = true
    return {
      ...attachment,
      name: nextName,
    }
  })

  return hasChanges ? normalizedAttachments : attachments
}

/**
 * 统计当前 composer 草稿中的媒体附件数量。
 *
 * @param attachments - 当前草稿附件。
 * @returns 按音频、图片、视频分组的数量。
 */
export const getComposerMediaAttachmentCounts = (
  attachments: ComposerFileAttachment[],
): ComposerMediaAttachmentCounts => {
  const counts: ComposerMediaAttachmentCounts = {
    audio: 0,
    image: 0,
    video: 0,
  }

  for (const attachment of attachments) {
    counts[attachment.kind] += 1
  }

  return counts
}

/**
 * 判断当前附件数量是否满足单次请求限制。
 *
 * @param attachments - 当前草稿附件。
 * @returns 未超过图片、视频、音频上限时返回 true。
 */
export const isComposerMediaWithinLimits = (attachments: ComposerFileAttachment[]) => {
  const counts = getComposerMediaAttachmentCounts(attachments)

  return (
    counts.audio <= COMPOSER_MEDIA_LIMITS.audio &&
    counts.image <= COMPOSER_MEDIA_LIMITS.image &&
    counts.video <= COMPOSER_MEDIA_LIMITS.video
  )
}

/**
 * 按单次请求上限拆分即将加入的附件。
 *
 * @param currentAttachments - 当前草稿里已有的附件。
 * @param incomingAttachments - 本次选择或拖入的新附件。
 * @returns 可加入草稿的附件与因超限被拒绝的附件。
 */
export const partitionComposerAttachmentsByLimits = (
  currentAttachments: ComposerFileAttachment[],
  incomingAttachments: ComposerFileAttachment[],
): ComposerAttachmentLimitPartition => {
  const counts = getComposerMediaAttachmentCounts(currentAttachments)
  const acceptedAttachments: ComposerFileAttachment[] = []
  const rejectedAttachments: ComposerFileAttachment[] = []

  for (const attachment of incomingAttachments) {
    if (counts[attachment.kind] >= COMPOSER_MEDIA_LIMITS[attachment.kind]) {
      rejectedAttachments.push(attachment)
      continue
    }

    counts[attachment.kind] += 1
    acceptedAttachments.push(attachment)
  }

  return {
    acceptedAttachments,
    rejectedAttachments,
  }
}

export const createComposerAttachmentsFromFiles = async (
  files: File[],
  options: CreateComposerAttachmentsFromFilesOptions = {},
): Promise<ComposerFileIngressResult> => {
  const results = await Promise.allSettled(files.map((file) => processLocalFile(file, options)))
  const attachments: ComposerFileAttachment[] = []
  const errors: string[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      attachments.push(result.value)
      continue
    }

    const message = result.reason instanceof Error ? result.reason.message : '处理附件失败。'
    errors.push(message)
  }

  return {
    attachments,
    errors,
  }
}

export const formatComposerAttachmentErrors = (errors: string[]) => {
  if (errors.length === 0) {
    return undefined
  }

  const unsupportedNames: string[] = []
  const genericErrors: string[] = []

  for (const error of errors) {
    if (error.startsWith('暂不支持该附件类型：')) {
      unsupportedNames.push(error.replace('暂不支持该附件类型：', '').trim())
      continue
    }

    genericErrors.push(error.trim())
  }

  const messages: string[] = []

  if (unsupportedNames.length > 0) {
    messages.push(`暂不支持以下附件类型：${formatAttachmentNames(unsupportedNames)}`)
  }

  for (const genericError of genericErrors) {
    if (genericError.length > 0) {
      messages.push(genericError)
    }
  }

  return messages.join(' ')
}

export const revokeComposerAttachmentObjectUrl = (attachment: ComposerFileAttachment) => {
  if (attachment.delivery !== 'local' || typeof globalThis.URL?.revokeObjectURL !== 'function') {
    return
  }

  if (
    typeof attachment.url === 'string' &&
    attachment.url.trim().length > 0 &&
    isBlobUrl(attachment.url.trim())
  ) {
    globalThis.URL.revokeObjectURL(attachment.url)
  }

  if (
    typeof attachment.thumbnailUrl === 'string' &&
    attachment.thumbnailUrl.trim().length > 0 &&
    attachment.thumbnailUrl !== attachment.url &&
    isBlobUrl(attachment.thumbnailUrl.trim())
  ) {
    globalThis.URL.revokeObjectURL(attachment.thumbnailUrl)
  }
}

export const revokeComposerAttachmentObjectUrls = (attachments: ComposerFileAttachment[]) => {
  for (const attachment of attachments) {
    revokeComposerAttachmentObjectUrl(attachment)
  }
}

export const revokeFilePartObjectUrls = (fileParts: ComposerFilePart[]) => {
  if (typeof globalThis.URL?.revokeObjectURL !== 'function') {
    return
  }

  const revokedUrls = new Set<string>()

  for (const filePart of fileParts) {
    if (typeof filePart.url !== 'string') {
      continue
    }

    const normalizedUrl = filePart.url.trim()

    if (normalizedUrl.length === 0 || !isBlobUrl(normalizedUrl) || revokedUrls.has(normalizedUrl)) {
      continue
    }

    revokedUrls.add(normalizedUrl)
    globalThis.URL.revokeObjectURL(normalizedUrl)
  }
}

export const revokeRemovedComposerAttachmentObjectUrls = (
  previousAttachments: ComposerFileAttachment[],
  nextAttachments: ComposerFileAttachment[],
) => {
  const nextAttachmentIds = new Set(nextAttachments.map((attachment) => attachment.id))

  revokeComposerAttachmentObjectUrls(
    previousAttachments.filter((attachment) => !nextAttachmentIds.has(attachment.id)),
  )
}

/**
 * 将上传失败规范化为聊天提交流程可分类的附件错误。
 *
 * @param attachmentName - 正在上传的 composer 附件展示名。
 * @param error - OSS 预签名或 PUT 上传阶段抛出的错误。
 * @returns 带有附件错误前缀和附件名的 Error，供聊天错误分类器识别。
 */
const createComposerUploadError = (attachmentName: string, error: unknown) => {
  const message = error instanceof Error ? error.message.trim() : ''
  const normalizedAttachmentName = attachmentName.trim() || '未命名附件'

  return new Error(
    `发送前上传失败：附件 ${normalizedAttachmentName} 上传失败：${message || '上传失败。'}`,
  )
}

/**
 * 将本地 composer 附件上传进素材库并转换为可提交的 file part。
 *
 * 身份先于发送存在：`assetId` 在字节动之前就由后端发下来，发送失败素材仍在库中可复用。
 * 地址与媒体类型都取登记返回的那一行——后端是从桶里读回来的，不是我们报上去的。
 *
 * @param attachment - delivery 为 local 的 composer 附件。
 * @returns 使用素材库公网地址与登记类型的提交 file part。
 * @throws 当本地 File 缺失、类型不收、图片尺寸不合格、上传或登记失败时抛出附件错误。
 */
const uploadLocalComposerAttachmentToFilePart = async (
  attachment: ComposerFileAttachment,
): Promise<ComposerFilePart> => {
  if (!isLocalAttachment(attachment)) {
    throw new Error(`附件 ${attachment.name} 缺少可上传的本地文件。`)
  }

  try {
    const asset = await uploadAndRegisterAsset(attachment.file)

    return {
      filename: attachment.name,
      mediaType: asset.contentType,
      type: 'file',
      url: asset.url,
    }
  } catch (error) {
    throw createComposerUploadError(attachment.name, error)
  }
}

/**
 * 将 composer 附件转换为项目消息 file part。
 *
 * @param params - 附件转换参数。
 * @param params.attachment - 需要转换的 composer 附件。
 * @param params.resolveUrl - 是否将相对 URL 解析为绝对地址。
 * @returns 可用于预览或提交的 file part。
 * @throws 当附件缺少 URL 或 mediaType 时抛出错误。
 */
const composerAttachmentToFilePart = ({
  attachment,
  resolveUrl,
}: {
  attachment: ComposerFileAttachment
  resolveUrl: boolean
}): ComposerFilePart => {
  if (typeof attachment.url !== 'string' || attachment.url.trim().length === 0) {
    throw new Error(`附件 ${attachment.name} 缺少可发送的资源地址。`)
  }

  if (typeof attachment.mediaType !== 'string' || attachment.mediaType.trim().length === 0) {
    throw new Error(`附件 ${attachment.name} 缺少 mediaType。`)
  }

  return {
    filename: attachment.name,
    mediaType: attachment.mediaType,
    type: 'file',
    url: resolveUrl ? resolveAttachmentAbsoluteUrl(attachment.url.trim()) : attachment.url.trim(),
  }
}

/**
 * 将 composer 附件转换为预览 file part，不触发 OSS 上传。
 *
 * @param attachments - 当前 composer 中的图片、视频或音频附件。
 * @returns 保留原始预览 URL 的 file part 列表。
 */
export const composerAttachmentsToPreviewFileParts = (
  attachments: ComposerFileAttachment[],
): ComposerFilePart[] =>
  attachments.map((attachment) =>
    composerAttachmentToFilePart({
      attachment,
      resolveUrl: false,
    }),
  )

/**
 * 将已准备好的 file part 转换为可恢复的远端 composer 附件。
 *
 * @param fileParts - 已上传或已是远端 URL 的提交附件。
 * @returns 可写入草稿或 sessionStorage 的远端附件。
 */
export const createRemoteComposerAttachmentsFromFileParts = (
  fileParts: ComposerFilePart[],
): ComposerFileAttachment[] => {
  const sequenceByKind: ComposerMediaAttachmentCounts = {
    audio: 1,
    image: 1,
    video: 1,
  }

  return fileParts.map((filePart) => {
    const kind = getComposerAttachmentKindFromMediaType(filePart.mediaType)
    const sequence = sequenceByKind[kind]
    sequenceByKind[kind] += 1
    const fallbackName = createComposerAttachmentDisplayName(kind, sequence)
    const name =
      typeof filePart.filename === 'string' && filePart.filename.trim().length > 0
        ? filePart.filename
        : fallbackName

    return {
      delivery: 'remote',
      id: `remote-${kind}-${createOpaqueIdSuffix(8)}`,
      kind,
      mediaType: filePart.mediaType,
      name,
      url: filePart.url,
    }
  })
}

export type PreparedComposerMessagePart = { type: 'text'; text: string } | ComposerFilePart

/**
 * 准备发送给 AG-UI 的有序消息 part：本地附件上传并登记进素材库，媒体位置原样保留。
 *
 * 同一附件被多个 chip 引用时只上传、登记一次，产出的 file part 按位置复用。
 *
 * @param parts - 聊天提交的有序消息 part。
 * @returns 文本原样、媒体替换为远端 file part 的有序列表。
 * @throws 当本地附件上传或登记失败、附件数据不完整时抛出可分类的附件错误。
 */
export const prepareComposerMessagePartsForSubmission = async (
  parts: readonly MediaComposerMessagePart[],
): Promise<PreparedComposerMessagePart[]> => {
  const filePartByAttachmentId = new Map<string, ComposerFilePart>()
  const prepared: PreparedComposerMessagePart[] = []

  for (const part of parts) {
    if (part.type === 'text') {
      prepared.push(part)
      continue
    }

    const { attachment } = part
    let filePart = filePartByAttachmentId.get(attachment.id)

    if (!filePart) {
      filePart =
        attachment.delivery === 'local'
          ? await uploadLocalComposerAttachmentToFilePart(attachment)
          : composerAttachmentToFilePart({ attachment, resolveUrl: false })

      if (getComposerAttachmentKindFromMediaType(filePart.mediaType) !== attachment.kind) {
        throw new Error(`附件 ${attachment.name} 的远端媒体类型不匹配`)
      }

      filePartByAttachmentId.set(attachment.id, filePart)
    }

    prepared.push(filePart)
  }

  return prepared
}

/**
 * 准备发送给 AG-UI 的附件 file part。
 *
 * @param attachments - 当前草稿中待发送的 composer 附件。
 * @returns 使用远端可访问 URL 的提交 file part 列表。
 * @throws 当本地附件上传或登记失败、附件数据不完整时抛出可分类的附件错误。
 */
export const prepareComposerAttachmentsForSubmission = async (
  attachments: ComposerFileAttachment[],
): Promise<PreparedComposerAttachmentsForSubmission> => {
  const preparedAttachments = await Promise.all(
    attachments.map(async (attachment) => {
      const filePart =
        attachment.delivery === 'local'
          ? await uploadLocalComposerAttachmentToFilePart(attachment)
          : composerAttachmentToFilePart({ attachment, resolveUrl: false })

      if (getComposerAttachmentKindFromMediaType(filePart.mediaType) !== attachment.kind) {
        throw new Error(`附件 ${attachment.name} 的远端媒体类型不匹配`)
      }

      return {
        filePart,
        remoteAttachment: {
          delivery: 'remote' as const,
          id: attachment.id,
          kind: attachment.kind,
          mediaType: filePart.mediaType,
          name: attachment.name,
          url: filePart.url,
        },
      }
    }),
  )

  return {
    fileParts: preparedAttachments.map((preparedAttachment) => preparedAttachment.filePart),
    remoteAttachments: preparedAttachments.map(
      (preparedAttachment) => preparedAttachment.remoteAttachment,
    ),
  }
}
