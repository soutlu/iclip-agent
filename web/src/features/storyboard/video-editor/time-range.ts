import { roundSeconds } from './time-label'

export type TimeRange = { start: number; end: number }

/** 可编辑选段的最短时长，不影响边界微调步长。 */
export const MIN_RANGE_SECONDS = 1

/** 约束选区且保留小数秒精度；素材不足最短时长时没有可用选区。 */
export const clampRange = (range: TimeRange, duration: number): TimeRange | undefined => {
  if (duration < MIN_RANGE_SECONDS) return undefined
  // 先把可用末端向内对齐到显示精度，避免四舍五入后越过素材末尾或不足 1 秒。
  const maxEnd = Math.floor(duration * 100) / 100
  const start = roundSeconds(Math.max(0, Math.min(range.start, maxEnd - MIN_RANGE_SECONDS)))
  const end = roundSeconds(Math.min(maxEnd, Math.max(range.end, start + MIN_RANGE_SECONDS)))
  return { start, end }
}
