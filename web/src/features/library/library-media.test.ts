import { describe, expect, it } from 'vitest'
import type { LibraryVideo } from './library.api'
import { aspectOf, durationSecondsOf, formatClock, openingTextOf } from './library-media'

const video = (patch: {
  durationMs?: number | null
  seconds?: number | null
  timelineEnd?: number
}): LibraryVideo => ({
  agentId: null,
  conversationId: null,
  face: {
    createdAt: '2026-09-20T10:00:00Z',
    durationMs: patch.durationMs ?? null,
    jobId: 'f',
    kind: 'take',
    outputUrl: 'https://oss.example.test/a.mp4',
    watermarkOutputUrl: null,
  },
  id: 't',
  shotIndex: 1,
  take: {
    aspectRatio: '9:16',
    createdAt: '2026-09-20T10:00:00Z',
    generateAudio: null,
    id: 't',
    masters: [],
    model: 'm',
    outputUrl: 'https://oss.example.test/a.mp4',
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
    userName: null,
    watermarkOutputUrl: null,
  },
  takeCount: 1,
  taskId: null,
  title: null,
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
  it('prefers the measured master length, then requested seconds, then the script end', () => {
    expect(durationSecondsOf(video({ durationMs: 7040, seconds: 10, timelineEnd: 8 }))).toBe(7.04)
    expect(durationSecondsOf(video({ seconds: 10, timelineEnd: 8 }))).toBe(10)
    expect(durationSecondsOf(video({ seconds: -1, timelineEnd: 8 }))).toBe(8)
    expect(durationSecondsOf(video({}))).toBeNull()
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
    const take = video({ timelineEnd: 3 }).take
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
