import { describe, expect, it } from 'vitest'
import { columnCountFor, snapshotWidthFor } from './library-layout'

describe('columnCountFor', () => {
  it.each([
    [0, 2],
    [699, 2],
    [700, 3],
    [1060, 4],
    [1380, 5],
    [2400, 5],
  ])('width %i gives %i columns', (width, count) => {
    expect(columnCountFor(width)).toBe(count)
  })
})

describe('snapshotWidthFor', () => {
  it.each([
    [150, 1, 240],
    [200, 2, 480],
    [260, 2, 640],
    [260, 3, 640],
    [500, 2, 720],
  ])('%i css px at %ix density asks for %i px', (css, ratio, width) => {
    expect(snapshotWidthFor(css, ratio)).toBe(width)
  })
})
