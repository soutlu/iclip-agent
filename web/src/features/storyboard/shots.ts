/** 分镜共用的文件路径、参考图上限、画幅与生成状态。 */

import type { GenerationOut } from '@/shared/api/generated/types.gen'
import { zGenerationOut } from '@/shared/api/generated/zod.gen'

type GenerationStatus = GenerationOut['status']

export const SHOTS_PATH = 'video_shot.json'

/** 每组参考图上限，与后端 MAX_REFERENCE_IMAGES 一致（见 contract/conventions.md）。 */
export const MAX_REFERENCE_IMAGES = 30

export const aspectRatioStyle = (aspectRatio: string) => aspectRatio.replace(':', ' / ')

/** 与状态角标的媒体状态同词，可直接传给它画。 */
export type GenerationPhase = 'queued' | 'running' | 'completed' | 'failed'

/** 业务状态到给人看的阶段：pending 还在本系统排队，submitting / submitted 已交给上游在跑。 */
export const phaseOfStatus = (status: GenerationStatus): GenerationPhase => {
  switch (status) {
    case 'pending':
      return 'queued'
    case 'submitting':
    case 'submitted':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
  }
}

/** 还没到终态的状态，从合同枚举按阶段筛出。 */
const IN_FLIGHT: ReadonlySet<GenerationStatus> = new Set(
  zGenerationOut.shape.status.options.filter((status) => {
    const phase = phaseOfStatus(status)
    return phase === 'queued' || phase === 'running'
  }),
)

export const isRunningStatus = (status: GenerationStatus): boolean => IN_FLIGHT.has(status)
