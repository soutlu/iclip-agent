/** 分镜共用的文件路径、参考图上限、画幅与生成状态。 */

export const SHOTS_PATH = 'video_shot.json'

/** 每组参考图上限，与后端 MAX_REFERENCE_IMAGES 一致（见 contract/conventions.md）。 */
export const MAX_REFERENCE_IMAGES = 30

export const aspectRatioStyle = (aspectRatio: string) => aspectRatio.replace(':', ' / ')

const IN_FLIGHT = new Set(['pending', 'submitting', 'submitted'])

export const isRunningStatus = (status: string): boolean => IN_FLIGHT.has(status)
