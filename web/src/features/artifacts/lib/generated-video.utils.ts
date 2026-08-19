import type {
  GeneratedVideoItem,
  GeneratedVideoOutput,
  GeneratedVideoStatus,
} from '@/features/artifacts/types/generated-video.types'
import { isRecord } from '@/shared/lib/guards'

const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

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

const GENERATED_VIDEO_CREATED_AT_SECONDS_BOUNDARY = 10_000_000_000

const getCreatedAtIsoString = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < GENERATED_VIDEO_CREATED_AT_SECONDS_BOUNDARY ? value * 1000 : value

    return new Date(milliseconds).toISOString()
  }

  const normalized = getNonEmptyString(value)

  if (!normalized) {
    return undefined
  }

  const parsed = Date.parse(normalized)

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

const getGeneratedVideoStatus = (value: unknown): GeneratedVideoStatus | undefined => {
  switch (value) {
    case 'cancelled':
    case 'failed':
    case 'processing':
    case 'queued':
    case 'running':
    case 'succeeded':
      return value
    default:
      return undefined
  }
}

const normalizeGeneratedVideoItem = (value: unknown): GeneratedVideoItem | null => {
  if (!isRecord(value)) {
    return null
  }

  const generationId = getNonEmptyString(value.generation_id)
  const status = getGeneratedVideoStatus(value.status)

  if (!generationId || !status) {
    return null
  }

  return {
    attempt: getPositiveInteger(value.attempt),
    createdAt: getCreatedAtIsoString(value.created_at),
    error: getNonEmptyString(value.error),
    generationId,
    outputUrl: getNonEmptyString(value.output_url),
    promptIndex: getPositiveInteger(value.prompt_index),
    status,
    taskId: getNonEmptyString(value.task_id),
  }
}

export const normalizeGeneratedVideoOutput = (value: unknown): GeneratedVideoOutput | null => {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null
  }

  const videos = value.items.flatMap((item) => {
    const normalized = normalizeGeneratedVideoItem(item)

    return normalized ? [normalized] : []
  })

  return videos.length > 0 ? { videos } : null
}
