import type {
  StoryboardOutput,
  StoryboardShot,
  StoryboardShotStatus,
  StoryboardShotVideoPromptStatus,
  StoryboardShotVideoStatus,
} from '@/features/artifacts/types/storyboard.types'
import { isRecord } from '@/shared/lib/guards'

const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const getNonEmptyStringList = (value: unknown) => {
  if (!Array.isArray(value)) {
    return undefined
  }

  const normalizedItems = value.flatMap((item) => {
    const normalized = getNonEmptyString(item)

    return normalized ? [normalized] : []
  })

  return normalizedItems.length > 0 ? normalizedItems : undefined
}

const getVideoPromptStatus = (value: unknown): StoryboardShotVideoPromptStatus | undefined => {
  if (value !== 'failed' && value !== 'succeeded') {
    return undefined
  }

  return value
}

const getVideoStatus = (value: unknown): StoryboardShotVideoStatus | undefined => {
  if (value !== 'failed' && value !== 'succeeded') {
    return undefined
  }

  return value
}

const getShotStatus = (value: unknown): StoryboardShotStatus | undefined => {
  if (value !== 'failed') {
    return undefined
  }

  return value
}

const hasValue = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return value.trim().length > 0
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (isRecord(value)) {
    return Object.values(value).some((item) => hasValue(item))
  }

  return false
}

const createShotID = (index: number) => String(index + 1).padStart(2, '0')

const normalizeStoryboardShot = (value: unknown, index: number): StoryboardShot | null => {
  if (!isRecord(value)) {
    return null
  }

  const imageUrls = getNonEmptyStringList(value.image_urls)
  const videoPromptStatus = getVideoPromptStatus(value.video_prompt_status)
  const videoStatus = getVideoStatus(value.video_status)
  const shotStatus = getShotStatus(value.status)
  const videoPrompt = getNonEmptyString(value.video_prompt)
  const videoPromptError = getNonEmptyString(value.video_prompt_error)
  const videoUrl = getNonEmptyString(value.video_url)
  const videoError = getNonEmptyString(value.video_error)
  const videoTaskId = getNonEmptyString(value.video_task_id)
  const shotError = getNonEmptyString(value.error)

  let normalizedVideoPromptStatus: StoryboardShotVideoPromptStatus | undefined
  let normalizedVideoStatus: StoryboardShotVideoStatus | undefined

  if (videoPromptStatus === 'succeeded' && videoPrompt) {
    normalizedVideoPromptStatus = 'succeeded'
  }

  if (videoPromptStatus === 'failed') {
    normalizedVideoPromptStatus = 'failed'
  }

  if (videoStatus === 'succeeded' && videoUrl) {
    normalizedVideoStatus = 'succeeded'
  }

  if (videoStatus === 'failed') {
    normalizedVideoStatus = 'failed'
  }

  const shot: StoryboardShot = {
    error: shotStatus === 'failed' ? (shotError ?? '分镜结构化失败') : undefined,
    id: createShotID(index),
    imageUrls,
    shotStatus,
    storyline: getNonEmptyString(value.storyline),
    structureLevel: getNonEmptyString(value.structural_level),
    videoError: videoStatus === 'failed' ? (videoError ?? '最终视频生成失败') : undefined,
    videoPrompt: videoPromptStatus === 'succeeded' && videoPrompt ? videoPrompt : undefined,
    videoPromptError:
      videoPromptStatus === 'failed' ? (videoPromptError ?? 'Video Prompt 生成失败') : undefined,
    videoPromptStatus: normalizedVideoPromptStatus,
    videoStatus: normalizedVideoStatus,
    videoTaskId,
    videoUrl: videoStatus === 'succeeded' && videoUrl ? videoUrl : undefined,
  }

  return hasValue(shot) ? shot : null
}

export const normalizeStoryboardOutput = (value: unknown): StoryboardOutput | null => {
  if (!isRecord(value)) {
    return null
  }

  const shotTable = Array.isArray(value.shot_list)
    ? value.shot_list.flatMap((item, index) => {
        const normalized = normalizeStoryboardShot(item, index)

        return normalized ? [normalized] : []
      })
    : []
  const storyboard: StoryboardOutput = {
    shotTable: shotTable.length > 0 ? shotTable : undefined,
  }

  return hasValue(storyboard) ? storyboard : null
}
