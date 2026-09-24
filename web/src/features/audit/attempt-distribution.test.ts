import { describe, expect, it } from 'vitest'
import {
  attemptChartModel,
  cumulativePass,
  foldTail,
  gini,
  lorenzPoints,
  topShareOfAttempts,
} from './attempt-distribution'
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

describe('最费劲那一成', () => {
  it('切点正好落在档位边界上就直接取那个点', () => {
    // 五个镜里最费劲的一个（20%）出了 5 次，占 10 次里的一半。
    expect(topShareOfAttempts(FIVE, 0.2)).toBeCloseTo(0.5, 6)
  })

  it('切点落在档位内部按镜数等分插值', () => {
    // 一成是半个镜：那个出五次的镜按镜数折半，得 2.5 次，占 25%。
    expect(topShareOfAttempts(FIVE, 0.1)).toBeCloseTo(0.25, 6)
  })

  it('各镜次数一致时，一成的镜就消耗一成的次数', () => {
    expect(topShareOfAttempts([{ attempts: 2, shots: 10 }], 0.1)).toBeCloseTo(0.1, 6)
  })

  it('没有镜时没有结论', () => {
    expect(topShareOfAttempts([], 0.1)).toBeNull()
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

describe('出片次数分析的整段模型', () => {
  it('折尾到 cap 画曲线，末档写「以上」，悬停说本档几镜与尚有几镜，结论取前两档', () => {
    const model = attemptChartModel(FIVE, [], 5)

    expect(model.passPoints.map((point) => [point.label, point.tooltipLabel])).toEqual([
      ['1 次', '1 次以内完成'],
      ['2 次', '2 次以内完成'],
      ['3 次', '3 次以内完成'],
      ['4 次', '4 次以内完成'],
      ['5 次以上', '5 次以上'],
    ])
    expect(model.passPoints.map((point) => point.value)).toEqual([0.6, 0.8, 0.8, 0.8, 1])
    expect(model.notes.get('1')).toBe('本档 3 镜 · 尚有 2 镜未完成')
    expect(model.notes.get('5')).toBe('本档 1 镜')
    expect(model.passSummary).toBe('一次完成 60% · 两次以内 80%')
    expect(model.beforePass).toBeUndefined()
    expect(model.beforeTopShare).toBeNull()
  })

  it('集中度、分档表与洛伦兹曲线吃未折叠的原始分布', () => {
    const model = attemptChartModel(FIVE, [], 3)

    expect(model.passPoints.map((point) => point.label)).toEqual(['1 次', '2 次', '3 次以上'])
    expect(model.rows.at(-1)).toEqual({ attempts: 3, atLeast: true, shots: 1, attemptShare: 0.5 })
    expect(model.topShare).toBeCloseTo(0.25)
    expect(model.concentration).toBeCloseTo(0.36)
    expect(model.lorenz.at(-1)).toEqual({ shotShare: 1, attemptShare: 1 })
  })

  it('上一期按本期的档位下标对齐，缺的档位是 null', () => {
    const before: AttemptBucket[] = [
      { attempts: 1, shots: 1 },
      { attempts: 2, shots: 1 },
    ]

    const model = attemptChartModel(FIVE, before, 5)

    expect(model.beforePass).toEqual([0.5, 1, null, null, null])
    expect(model.beforeTopShare).not.toBeNull()
  })

  it('没有出片记录时曲线与结论都空', () => {
    const model = attemptChartModel([], [], 5)

    expect(model.passPoints).toEqual([])
    expect(model.passSummary).toBeUndefined()
    expect(model.rows).toEqual([])
    expect(model.concentration).toBeNull()
  })
})
