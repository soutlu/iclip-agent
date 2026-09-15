import { roundSeconds } from './time-label'

export type TimeRange = { start: number; end: number }

/** 选段至少这么长；再短模型看不出要改什么。 */
export const MIN_RANGE_SECONDS = 0.1

/** 手柄两端各自能到哪：开始不能越过结束，结束不能越过开始。 */
export const clampRange = (range: TimeRange, duration: number): TimeRange => {
  const start = Math.max(0, Math.min(range.start, duration - MIN_RANGE_SECONDS))
  const end = Math.min(duration, Math.max(range.end, start + MIN_RANGE_SECONDS))
  return { start: roundSeconds(start), end: roundSeconds(end) }
}
