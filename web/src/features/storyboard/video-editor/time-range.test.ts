import { describe, expect, it } from 'vitest'
import { clampRange } from './time-range'

describe('clampRange', () => {
  it('保留小数秒起止位置，不吸附到整秒', () => {
    expect(clampRange({ start: 1.25, end: 2.75 }, 6)).toEqual({ start: 1.25, end: 2.75 })
  })

  it('选段不足 1 秒时约束到最短时长', () => {
    expect(clampRange({ start: 1.2, end: 1.6 }, 6)).toEqual({ start: 1.2, end: 2.2 })
  })

  it.each([1.005, 1.006, 6.006])('素材末端 %s 的选区不因四舍五入短于 1 秒或越界', (duration) => {
    const range = clampRange({ start: duration, end: duration }, duration)
    expect(range).toBeDefined()
    if (range === undefined) throw new Error('素材可容纳选区')
    expect(range.end).toBeLessThanOrEqual(duration)
    expect(Math.round((range.end - range.start) * 100)).toBeGreaterThanOrEqual(100)
  })

  it('恰好 1 秒的素材选择整条，不足 1 秒的素材没有有效选区', () => {
    expect(clampRange({ start: 0, end: 0.2 }, 1)).toEqual({ start: 0, end: 1 })
    expect(clampRange({ start: 0, end: 0.9 }, 0.9)).toBeUndefined()
  })
})
