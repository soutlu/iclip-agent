import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'

/** 分镜出片入口提供的模型；值使用 multiflow 的公开调用名。 */
export const VIDEO_MODELS = [
  { label: 'Wan3', value: 'wan3.0-video' },
  { label: 'SD2.5', value: 'mmt-seedance-2-5' },
  { label: 'SD2', value: 'mmt-seedance-2-0' },
] as const

export type VideoGenerationOptions = {
  model: NonNullable<VideoGenerationIn['model']>
  generateAudio: NonNullable<VideoGenerationIn['generateAudio']>
}

export const DEFAULT_VIDEO_OPTIONS: VideoGenerationOptions = {
  generateAudio: true,
  model: 'mmt-seedance-2-0',
}
