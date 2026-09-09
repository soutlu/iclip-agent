import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'

/** 出片入口上用户可调的两项。模型清单由服务端配置给出，还没读到时 model 为空。 */
export type VideoGenerationOptions = {
  model: VideoGenerationIn['model'] | undefined
  generateAudio: NonNullable<VideoGenerationIn['generate_audio']>
}

export const DEFAULT_GENERATE_AUDIO = true
