import { describe, expect, it } from 'vitest'
import type { LibraryTake, LibraryVersionOut } from './library.api'
import {
  aspectOf,
  cutIndexAt,
  durationSecondsOf,
  formatClock,
  keyframesOf,
  openingTextOf,
  promptSegmentsOf,
  versionsOf,
} from './library-media'

const takeOf = (patch: { seconds?: number | null; timelineEnd?: number }): LibraryTake => ({
  aspectRatio: '9:16',
  generateAudio: null,
  id: 't',
  model: 'm',
  prompt: '原文',
  referenceImageUrls: [],
  resolution: null,
  script:
    patch.timelineEnd === undefined
      ? null
      : {
          globalSettings: '设定',
          timeline: [{ end: patch.timelineEnd, imageIndexes: [], prompt: '一', start: 0 }],
        },
  seconds: patch.seconds ?? null,
})

describe('aspectOf', () => {
  it.each([
    ['9:16', { h: 16, w: 9 }],
    ['16:9', { h: 9, w: 16 }],
    ['2.39:1', { h: 1, w: 2.39 }],
    ['adaptive', { h: 16, w: 9 }],
    [null, { h: 16, w: 9 }],
    ['0:1', { h: 16, w: 9 }],
  ])('%s', (ratio, expected) => {
    expect(aspectOf(ratio)).toEqual(expected)
  })
})

describe('durationSecondsOf', () => {
  it('prefers the measured composite length, then requested seconds, then the script end', () => {
    expect(durationSecondsOf(7040, takeOf({ seconds: 10, timelineEnd: 8 }))).toBe(7.04)
    expect(durationSecondsOf(null, takeOf({ seconds: 10, timelineEnd: 8 }))).toBe(10)
    expect(durationSecondsOf(null, takeOf({ seconds: -1, timelineEnd: 8 }))).toBe(8)
    expect(durationSecondsOf(null, takeOf({}))).toBeNull()
  })
})

describe('formatClock', () => {
  it.each([
    [0.2, '0:01'],
    [7.04, '0:07'],
    [15, '0:15'],
    [75, '1:15'],
  ])('%f seconds', (seconds, text) => {
    expect(formatClock(seconds)).toBe(text)
  })
})

describe('openingTextOf', () => {
  it('uses the first cut and drops image references', () => {
    const take = takeOf({ timelineEnd: 3 })
    const withRef = {
      ...take,
      script: {
        globalSettings: '设定',
        timeline: [{ end: 3, imageIndexes: [1], prompt: '踩入 @Image1 凉鞋。', start: 0 }],
      },
    }

    expect(openingTextOf(withRef)).toBe('踩入 凉鞋。')
    expect(openingTextOf({ ...take, script: null, prompt: '  纯文本描述。 ' })).toBe('纯文本描述。')
  })
})

const scripted = (...cuts: [number, number][]): LibraryTake => ({
  ...takeOf({}),
  script: {
    globalSettings: '设定',
    timeline: cuts.map(([start, end], order) => ({
      end,
      imageIndexes: [],
      prompt: `第${order + 1}镜`,
      start,
    })),
  },
})

describe('keyframesOf', () => {
  it('takes one frame at the middle of every cut', () => {
    expect(keyframesOf(scripted([0, 3], [3, 10]), 12)).toEqual([
      { at: 1.5, end: 3, index: 1, prompt: '第1镜', start: 0 },
      { at: 6.5, end: 10, index: 2, prompt: '第2镜', start: 3 },
    ])
  })

  it.each([
    [6, 4],
    [10, 5],
    [30, 8],
  ])('spreads frames evenly over %i seconds of plain text', (seconds, count) => {
    const frames = keyframesOf(takeOf({}), seconds)
    expect(frames).toHaveLength(count)
    expect(frames[0]).toMatchObject({ at: seconds / count / 2, prompt: null, start: 0 })
    expect(frames.at(-1)?.end).toBeCloseTo(seconds)
  })

  it('has no storyboard for plain text of unknown length', () => {
    expect(keyframesOf(takeOf({}), null)).toEqual([])
  })
})

describe('promptSegmentsOf', () => {
  it('turns references to existing images into image segments and keeps the rest as text', () => {
    expect(promptSegmentsOf('托出 @Image1 和 @Image3。', ['a.png', 'b.png'])).toEqual([
      { kind: 'text', start: 0, text: '托出 ' },
      { kind: 'image', number: 1, start: 3, url: 'a.png' },
      { kind: 'text', start: 10, text: ' 和 ' },
      { kind: 'text', start: 13, text: '@Image3' },
      { kind: 'text', start: 20, text: '。' },
    ])
  })
})

describe('cutIndexAt', () => {
  it('includes the start and excludes the end of a cut', () => {
    const script = scripted([0, 3], [3, 10]).script
    if (script === null) throw new Error('需要分镜')
    expect([0, 2.9, 3, 9.99, 10].map((at) => cutIndexAt(script, at))).toEqual([0, 0, 1, 1, -1])
  })
})

describe('versionsOf', () => {
  it('numbers takes and composites of a group together in the order given', () => {
    const version = (jobId: string, kind: LibraryVersionOut['kind']): LibraryVersionOut => ({
      durationMs: kind === 'composite' ? 9000 : null,
      finishedAt: '2026-09-20T12:00:00Z',
      jobId,
      kind,
      outputUrl: `https://oss.example.test/${jobId}.mp4`,
      take: takeOf({}),
      userName: null,
      watermarkOutputUrl: null,
    })

    const versions = versionsOf({
      shotIndex: 1,
      versions: [version('t1', 'take'), version('c1', 'composite'), version('t2', 'take')],
    })

    expect(versions.map((item) => [item.jobId, item.kind, item.label])).toEqual([
      ['t1', 'take', '第 1 版'],
      ['c1', 'composite', '第 2 版'],
      ['t2', 'take', '第 3 版'],
    ])
  })
})
