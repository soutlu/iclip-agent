/** 出片次数分布的派生计算：累计通过曲线、洛伦兹曲线与集中度。
 *
 * 口径：一个镜的出片次数是它名下全部出片记录条数，不看终态——出过视频就算这一镜有了结果，
 * 所以累计曲线末档一定收在 100%，没有「没成」这一类。接口给的是不封顶的原始分布，折尾只发生
 * 在展示层，集中度一律从原始分布算。 */

import type { AttemptBucket } from './audit.api'

/** 曲线上的一档。 */
export type PassPoint = {
  attempts: number
  /** 正好出了这么多次的镜数。 */
  shots: number
  /** 进到这一次的镜数，即前面几档没能收工的那些；样本可信度看它。 */
  entering: number
  /** 到这一次为止累计收工的镜占比。 */
  cumulative: number
}

export type LorenzPoint = {
  /** 累计走过的镜占比。 */
  shotShare: number
  /** 这些镜累计吃掉的出片次数占比。 */
  attemptShare: number
}

const byAttempts = (buckets: readonly AttemptBucket[]): AttemptBucket[] =>
  [...buckets].sort((a, b) => a.attempts - b.attempts)

const totalShots = (buckets: readonly AttemptBucket[]): number =>
  buckets.reduce((sum, bucket) => sum + bucket.shots, 0)

/** 把 ``cap`` 及以上并成一档（档位记作 cap）。本期与上期要用同一个 cap，否则按下标对齐会错位。 */
export const foldTail = (buckets: readonly AttemptBucket[], cap = 5): AttemptBucket[] => {
  const folded: AttemptBucket[] = []
  let tail = 0
  for (const bucket of byAttempts(buckets)) {
    if (bucket.attempts >= cap) tail += bucket.shots
    else folded.push(bucket)
  }
  if (tail > 0) folded.push({ attempts: cap, shots: tail })
  return folded
}

/** 累计通过曲线。中间没有镜的档位补零，不然阶梯会跳过空档——所以调用方先折尾，别喂原始分布。 */
export const cumulativePass = (buckets: readonly AttemptBucket[]): PassPoint[] => {
  const sorted = byAttempts(buckets)
  const total = totalShots(sorted)
  if (total === 0) return []
  const last = sorted[sorted.length - 1]?.attempts ?? 0
  const shotsAt = new Map(sorted.map((bucket) => [bucket.attempts, bucket.shots]))
  const points: PassPoint[] = []
  let done = 0
  for (let attempts = 1; attempts <= last; attempts += 1) {
    const shots = shotsAt.get(attempts) ?? 0
    points.push({ attempts, shots, entering: total - done, cumulative: (done + shots) / total })
    done += shots
  }
  return points
}

/** 洛伦兹曲线：镜按出片次数从少到多排队，逐档累加两个占比。含原点，末点必为 (1, 1)。 */
export const lorenzPoints = (buckets: readonly AttemptBucket[]): LorenzPoint[] => {
  const sorted = byAttempts(buckets)
  const shots = totalShots(sorted)
  const attempts = sorted.reduce((sum, bucket) => sum + bucket.attempts * bucket.shots, 0)
  if (shots === 0 || attempts === 0) return []
  const points: LorenzPoint[] = [{ shotShare: 0, attemptShare: 0 }]
  let seenShots = 0
  let seenAttempts = 0
  for (const bucket of sorted) {
    seenShots += bucket.shots
    seenAttempts += bucket.attempts * bucket.shots
    points.push({ shotShare: seenShots / shots, attemptShare: seenAttempts / attempts })
  }
  return points
}

/** 集中度（基尼系数）：0 是每个镜花的次数一样，越大越集中在个别镜。
 *
 * 只吃未折叠的原始分布——折过尾的分布把长尾压成一档，算出来偏小。 */
export const gini = (buckets: readonly AttemptBucket[]): number | null => {
  const points = lorenzPoints(buckets)
  if (points.length < 2) return null
  let area = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    if (previous === undefined || current === undefined) continue
    area +=
      ((current.shotShare - previous.shotShare) * (previous.attemptShare + current.attemptShare)) /
      2
  }
  return Math.max(0, 1 - 2 * area)
}
