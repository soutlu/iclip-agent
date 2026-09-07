import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'

/** 分镜出片入口提供的模型；值使用视频接口的公开调用名。 */
export const VIDEO_MODELS = [
  { label: 'SD2.5', value: 'moyu-seedance-2-5' },
  { label: 'SD2.0', value: 'moyu-seedance-2-0' },
] as const

export type VideoGenerationOptions = {
  model: NonNullable<VideoGenerationIn['model']>
  generateAudio: NonNullable<VideoGenerationIn['generateAudio']>
}

export const DEFAULT_VIDEO_OPTIONS: VideoGenerationOptions = {
  generateAudio: true,
  model: 'moyu-seedance-2-5',
}
