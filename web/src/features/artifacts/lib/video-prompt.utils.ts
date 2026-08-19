import type {
  VideoPromptBatch,
  VideoPromptOutput,
  VideoPromptPreviewImage,
} from '@/features/artifacts/types/video-prompt.types'
import { isRecord } from '@/shared/lib/guards'

/**
 * 从未知值中读取非空字符串。
 *
 * @param value - 待读取的未知值。
 * @returns 去除首尾空白后的字符串；值不是非空字符串时返回 undefined。
 */
const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/**
 * 从未知值中读取正整数。
 *
 * @param value - 待读取的未知值。
 * @returns 输入为正整数时返回该数字，否则返回 undefined。
 */
const getPositiveInteger = (value: unknown) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return undefined
  }

  return value
}

/**
 * 将镜头级 image_urls 转换为可渲染的图片引用。
 *
 * @param value - 后端返回的镜头图片 URL 数组。
 * @returns 按数组顺序生成的图片缩略图引用列表；字段不是数组时返回 null。
 */
const getPreviewImagesFromImageUrls = (value: unknown): VideoPromptPreviewImage[] | null => {
  if (!Array.isArray(value)) {
    return null
  }

  return value.flatMap((item, index) => {
    const url = getNonEmptyString(item)

    return url ? [{ key: `Image${index + 1}`, url }] : []
  })
}

/**
 * 规范化单个视频提示词镜头。
 *
 * @param value - 后端返回的单个镜头原始值。
 * @returns 可渲染的视频提示词镜头；格式无效时返回 null。
 */
const normalizeVideoPromptBatch = (value: unknown): VideoPromptBatch | null => {
  if (!isRecord(value)) {
    return null
  }

  const index = getPositiveInteger(value.index)
  const prompt = getNonEmptyString(value.prompt)
  const previewImages = getPreviewImagesFromImageUrls(value.image_urls)
  const second = getPositiveInteger(value.seconds)

  if (!index || !prompt || !previewImages || !second) {
    return null
  }

  return {
    index,
    prompt,
    ...(previewImages.length > 0 ? { previewImages } : {}),
    second,
  }
}

/**
 * 规范化视频提示词 artifact 输出。
 *
 * @param value - 后端视频提示词原始内容。
 * @returns 可渲染的视频提示词输出；格式无效时返回 null。
 */
export const normalizeVideoPromptOutput = (value: unknown): VideoPromptOutput | null => {
  if (!isRecord(value) || !Array.isArray(value.shots)) {
    return null
  }

  const aspectRatio = getNonEmptyString(value.aspect_ratio)

  if (!aspectRatio) {
    return null
  }

  const batches = value.shots.flatMap((item) => {
    const normalized = normalizeVideoPromptBatch(item)

    return normalized ? [normalized] : []
  })
  const summary = getNonEmptyString(value.summary) ?? `已生成 ${batches.length} 个视频镜头提示词。`

  return batches.length > 0 ? { ...(aspectRatio ? { aspectRatio } : {}), batches, summary } : null
}
