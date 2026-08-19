import type {
  ImageAnalysisSummaryItem,
  ImageAnalysisSummaryOutput,
} from '@/features/artifacts/types/image-analysis-summary.types'
import { isRecord } from '@/shared/lib/guards'

const DEFAULT_IMAGE_ANALYSIS_CATEGORY = '图片'

/**
 * 读取非空字符串。
 *
 * @param value - 待读取的未知值。
 * @returns 去除首尾空白后的字符串；值不是非空字符串时返回 undefined。
 */
const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/**
 * 归一化单个图片解析汇总条目。
 *
 * @param value - 后端或 adapter 构造出的图片解析条目。
 * @returns 可渲染的图片解析条目；缺少 key 或描述时返回 null。
 */
const normalizeImageAnalysisSummaryItem = (value: unknown): ImageAnalysisSummaryItem | null => {
  if (!isRecord(value)) {
    return null
  }

  const key = getNonEmptyString(value.key)
  const description = getNonEmptyString(value.description)

  if (!key || !description) {
    return null
  }

  const category = getNonEmptyString(value.category) ?? DEFAULT_IMAGE_ANALYSIS_CATEGORY
  const filename = getNonEmptyString(value.filename)
  const thumbnailUrl = getNonEmptyString(value.thumbnailUrl)
  const url = getNonEmptyString(value.url)

  return {
    category,
    description,
    ...(filename ? { filename } : {}),
    key,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(url ? { url } : {}),
  }
}

/**
 * 将图片解析汇总 artifact payload 归一化为前端展示数据。
 *
 * @param value - 后端或 adapter 构造出的图片解析汇总数据。
 * @returns 可渲染的图片解析汇总；格式无效时返回 null。
 */
export const normalizeImageAnalysisSummaryOutput = (
  value: unknown,
): ImageAnalysisSummaryOutput | null => {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null
  }

  const items = value.items.flatMap((item) => {
    const normalizedItem = normalizeImageAnalysisSummaryItem(item)

    return normalizedItem ? [normalizedItem] : []
  })

  if (items.length === 0) {
    return null
  }

  return {
    items,
  }
}
