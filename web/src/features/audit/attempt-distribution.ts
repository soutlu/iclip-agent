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

/** 分档表的一行。 */
export type DistributionRow = {
  attempts: number
  /** 末档并了「这么多次及以上」，显示时要写成「N 次以上」。 */
  atLeast: boolean
  shots: number
  /** 这一档消耗的出片次数占全部次数的比例。 */
  attemptShare: number
}

/** 分档表：档位、镜数与这一档消耗的次数比例。
 *
 * 末档的次数按原始分布实际加总——折尾只是把档位并起来，档里的镜各出了多少次不能按 ``cap`` 算。 */
export const distributionRows = (buckets: readonly AttemptBucket[], cap = 5): DistributionRow[] => {
  const sorted = byAttempts(buckets)
  const total = sorted.reduce((sum, bucket) => sum + bucket.attempts * bucket.shots, 0)
  if (total === 0) return []
  const rows: DistributionRow[] = []
  let tailShots = 0
  let tailAttempts = 0
  for (const bucket of sorted) {
    if (bucket.attempts >= cap) {
      tailShots += bucket.shots
      tailAttempts += bucket.attempts * bucket.shots
      continue
    }
    rows.push({
      attempts: bucket.attempts,
      atLeast: false,
      shots: bucket.shots,
      attemptShare: (bucket.attempts * bucket.shots) / total,
    })
  }
  if (tailShots > 0) {
    rows.push({
      attempts: cap,
      atLeast: true,
      shots: tailShots,
      attemptShare: tailAttempts / total,
    })
  }
  return rows
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

/** 出片次数最多的那 ``topShare`` 的镜，消耗了多少比例的出片次数。
 *
 * 取固定切片（缺省一成）而不是队尾那一档：队尾可能只有一个镜，比例小得没有意义，也没法跨期比。
 * 切点落在某一档内部时按这一档线性插值——档内每个镜的次数相同，插值就是按镜数等分。 */
export const topShareOfAttempts = (
  buckets: readonly AttemptBucket[],
  topShare = 0.1,
): number | null => {
  const points = lorenzPoints(buckets)
  if (points.length < 2) return null
  const cut = 1 - topShare
  for (const [previous, current] of points
    .slice(0, -1)
    .map((p, i) => [p, points[i + 1]] as const)) {
    if (current === undefined || current.shotShare < cut) continue
    const span = current.shotShare - previous.shotShare
    const ratio = span === 0 ? 1 : (cut - previous.shotShare) / span
    const atCut = previous.attemptShare + ratio * (current.attemptShare - previous.attemptShare)
    return 1 - atCut
  }
  return null
}

/** 集中度（基尼系数）：0 为各镜一致，数值越大越集中于少数镜。
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

/** 累计通过曲线上画的一档：折尾后的档位、刻度与悬停文字。 */
export type AttemptCurvePoint = {
  key: string
  label: string
  tooltipLabel: string
  value: number
}

export type AttemptChartModel = {
  /** 累计通过曲线的点，末档是「cap 次以上」。 */
  passPoints: AttemptCurvePoint[]
  /** 上一期按下标对齐的累计值；没有上一期为 undefined。 */
  beforePass: (number | null)[] | undefined
  /** 每一档的悬停说明，按 ``passPoints`` 的 key 查。 */
  notes: Map<string, string>
  passSummary: string | undefined
  lorenz: LorenzPoint[]
  rows: DistributionRow[]
  topShare: number | null
  beforeTopShare: number | null
  concentration: number | null
}

/**
 * 总览「出片次数分析」一段要画的全部东西。
 *
 * 折尾只为画图，本期与上期折到同一档位才能按下标对齐；集中度、分档表与洛伦兹曲线一律吃未折叠的原始分布。
 */
export const attemptChartModel = (
  distribution: readonly AttemptBucket[],
  before: readonly AttemptBucket[],
  cap = 5,
): AttemptChartModel => {
  const pass = cumulativePass(foldTail(distribution, cap))
  const passPoints = pass.map((point) => {
    // 折尾后的末档装着「cap 次及以上」，标签与悬停都照这个说，不能写成「以内完成」。
    const tail = point.attempts === cap
    const label = tail ? `${cap} 次以上` : `${point.attempts} 次`
    return {
      key: String(point.attempts),
      label,
      tooltipLabel: tail ? label : `${label}以内完成`,
      value: point.cumulative,
    }
  })
  const beforeAt = new Map(
    cumulativePass(foldTail(before, cap)).map((point) => [point.attempts, point.cumulative]),
  )
  const beforePass =
    before.length === 0
      ? undefined
      : passPoints.map((point) => beforeAt.get(Number(point.key)) ?? null)
  // 末档一定收在 100%，「尚有 N 镜未完成」在那里恒为 0，不写。
  const notes = new Map(
    pass.map((point, index) => [
      String(point.attempts),
      index === pass.length - 1
        ? `本档 ${point.shots} 镜`
        : `本档 ${point.shots} 镜 · 尚有 ${point.entering - point.shots} 镜未完成`,
    ]),
  )
  const passSummary =
    pass.length < 2
      ? undefined
      : `一次完成 ${Math.round((pass[0]?.cumulative ?? 0) * 100)}% · 两次以内 ${Math.round(
          (pass[1]?.cumulative ?? 0) * 100,
        )}%`
  return {
    passPoints,
    beforePass,
    notes,
    passSummary,
    lorenz: lorenzPoints(distribution),
    rows: distributionRows(distribution, cap),
    topShare: topShareOfAttempts(distribution),
    beforeTopShare: topShareOfAttempts(before),
    concentration: gini(distribution),
  }
}
