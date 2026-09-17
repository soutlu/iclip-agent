import { describe, expect, it } from 'vitest'
import { cumulativePass, foldTail, gini, lorenzPoints } from './attempt-distribution'
import type { AttemptBucket } from './audit.api'

/** 五个镜：1、1、1、2、5 次，共 10 次出片。手算过的一组，改口径时这组数会先红。 */
const FIVE: AttemptBucket[] = [
  { attempts: 1, shots: 3 },
  { attempts: 2, shots: 1 },
  { attempts: 5, shots: 1 },
]

describe('累计通过曲线', () => {
  it('逐档累加，末档收在 100%', () => {
    const points = cumulativePass([
      { attempts: 1, shots: 62 },
      { attempts: 2, shots: 24 },
    ])

    expect(points.map((point) => point.cumulative)).toEqual([62 / 86, 1])
    expect(points.map((point) => point.entering)).toEqual([86, 24])
  })

  it('中间没有镜的档位补零，阶梯不跳档', () => {
    const points = cumulativePass(FIVE)

    expect(points.map((point) => point.attempts)).toEqual([1, 2, 3, 4, 5])
    expect(points.map((point) => point.shots)).toEqual([3, 1, 0, 0, 1])
    expect(points.map((point) => point.entering)).toEqual([5, 2, 1, 1, 1])
  })

  it('没有镜就没有曲线', () => {
    expect(cumulativePass([])).toEqual([])
  })
})

describe('折尾', () => {
  it('cap 及以上并成一档，档位记作 cap', () => {
    expect(
      foldTail([
        { attempts: 1, shots: 3 },
        { attempts: 5, shots: 2 },
        { attempts: 9, shots: 1 },
      ]),
    ).toEqual([
      { attempts: 1, shots: 3 },
      { attempts: 5, shots: 3 },
    ])
  })
})

describe('集中度', () => {
  it('五个镜那组是 0.36', () => {
    expect(gini(FIVE)).toBeCloseTo(0.36, 2)
  })

  it('每个镜花一样多次就是 0', () => {
    expect(gini([{ attempts: 2, shots: 7 }])).toBeCloseTo(0, 6)
  })

  it('没有镜时没有集中度', () => {
    expect(gini([])).toBeNull()
  })

  it('折过尾的分布会把长尾压平，所以只能喂原始分布', () => {
    const tailHeavy: AttemptBucket[] = [
      { attempts: 1, shots: 60 },
      { attempts: 12, shots: 5 },
    ]

    expect(gini(foldTail(tailHeavy))).toBeLessThan(gini(tailHeavy) ?? 0)
  })
})

describe('洛伦兹曲线', () => {
  it('从原点出发，末点是 (1, 1)', () => {
    const points = lorenzPoints(FIVE)

    expect(points[0]).toEqual({ shotShare: 0, attemptShare: 0 })
    expect(points.at(-1)).toEqual({ shotShare: 1, attemptShare: 1 })
    expect(points[1]).toEqual({ shotShare: 0.6, attemptShare: 0.3 })
  })

  it('没有镜就没有曲线', () => {
    expect(lorenzPoints([])).toEqual([])
  })
})
