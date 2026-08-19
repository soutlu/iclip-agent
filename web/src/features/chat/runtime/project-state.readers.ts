import { isRecord, nonEmptyString } from '@/shared/lib/guards'

export const GENERATED_VIDEO_ARTIFACT_ID = 'artifact:state:video:generated-video'
export const VIDEO_SHOT_PATH = 'video_shot.json'
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx'] as const

export interface WorkspaceDocument {
  content: string
  etag: string
  path: string
}

export const requiredString = (value: unknown, field: string) => {
  const normalized = nonEmptyString(value)

  if (!normalized) {
    throw new Error(`业务数据缺少 ${field}`)
  }

  return normalized
}

export const requiredTimestampMs = (value: unknown, field: string) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }

  const normalized = nonEmptyString(value)

  if (normalized) {
    const parsedTimestamp = Date.parse(normalized)

    if (Number.isFinite(parsedTimestamp)) {
      return parsedTimestamp
    }
  }

  throw new Error(`业务数据 ${field} 必须是有效时间`)
}

export const requiredTimestampIsoString = (value: unknown, field: string) =>
  new Date(requiredTimestampMs(value, field)).toISOString()

export const recordArray = (value: unknown, field: string) => {
  if (!Array.isArray(value)) {
    throw new Error(`业务数据 ${field} 必须是数组`)
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`业务数据 ${field}[${index}] 必须是对象`)
    }

    return item
  })
}
