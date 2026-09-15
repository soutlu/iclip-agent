import { describe, expect, it } from 'vitest'

import {
  applyEdit,
  createOriginalVersion,
  durationOf,
  makeDemoVersions,
  timelineSegments,
  type VideoEdit,
} from './editor-model'

const edit: VideoEdit = {
  id: 'v2',
  label: 'V2',
  kind: 'modify',
  start: 4,
  end: 8,
  prompt: '调整背景',
}

describe('video editor version projection', () => {
  it('retains inherited edits and maps later changes back to the original clock', () => {
    const [original, v2, v3] = makeDemoVersions()
    expect(original).toBeDefined()
    expect(v2).toBeDefined()
    expect(v3).toBeDefined()
    if (!original || !v2 || !v3) throw new Error('Missing demo version')

    expect(v2.parentId).toBe(original.id)
    expect(v3.parentId).toBe(v2.id)
    expect(durationOf(original)).toBe(15)
    expect(durationOf(v3)).toBe(17)
    expect(
      timelineSegments(v3)
        .filter((segment) => segment.changeKind !== 'original')
        .map((segment) => [
          segment.currentStart,
          segment.currentEnd,
          segment.sourceStart,
          segment.sourceEnd,
          segment.changeKind,
          segment.originVersionId,
        ]),
    ).toEqual([
      [4, 8, 4, 8, 'modify', 'v2'],
      [8, 10, null, null, 'extend', 'v3'],
      [13, 15, 11, 13, 'modify', 'v3'],
    ])
  })

  it('only replaces the overlap of a previous edit and leaves its remainder inherited', () => {
    const original = createOriginalVersion(15)
    const v2 = applyEdit(original, edit)
    const v3 = applyEdit(v2, { ...edit, id: 'v3', label: 'V3', start: 6, end: 10 })
    expect(
      timelineSegments(v3).map((segment) => [
        segment.currentStart,
        segment.currentEnd,
        segment.sourceStart,
        segment.sourceEnd,
        segment.originVersionId,
      ]),
    ).toEqual([
      [0, 4, 0, 4, 'original'],
      [4, 6, 4, 6, 'v2'],
      [6, 10, 6, 10, 'v3'],
      [10, 15, 10, 15, 'original'],
    ])
    expect(new Set(v3.segments.map((segment) => segment.id)).size).toBe(v3.segments.length)
  })

  it('keeps inserted content unmapped when a later modification spans it', () => {
    const original = createOriginalVersion(15)
    const v2 = applyEdit(original, { ...edit, kind: 'extend', extension: 2 })
    const v3 = applyEdit(v2, { ...edit, id: 'v3', label: 'V3', start: 7, end: 11 })
    expect(durationOf(v3)).toBe(17)
    expect(
      timelineSegments(v3)
        .filter((segment) => segment.originVersionId === 'v3')
        .map((segment) => [
          segment.currentStart,
          segment.currentEnd,
          segment.sourceStart,
          segment.sourceEnd,
          segment.changeKind,
        ]),
    ).toEqual([
      [7, 8, 7, 8, 'modify'],
      [8, 10, null, null, 'modify'],
      [10, 11, 8, 9, 'modify'],
    ])
  })

  it('clamps finite ranges to the current duration and supports extension at either boundary', () => {
    const original = createOriginalVersion(15)
    const whole = applyEdit(original, { ...edit, start: -2, end: 30 })
    expect(whole.segments).toHaveLength(1)
    expect(whole.segments[0]).toMatchObject({ duration: 15, changeKind: 'modify' })

    for (const position of [0, 15]) {
      const extended = applyEdit(original, {
        ...edit,
        kind: 'extend',
        start: position,
        end: position,
        extension: 1,
      })
      expect(durationOf(extended)).toBe(16)
      expect(extended.segments.every((segment) => segment.duration > 0)).toBe(true)
      expect(
        timelineSegments(extended).find((segment) => segment.changeKind === 'extend'),
      ).toMatchObject({ currentStart: position, currentEnd: position + 1 })
    }
  })

  it.each([
    { start: 8, end: 4 },
    { start: 4, end: 4 },
    { start: 20, end: 25 },
    { start: Number.NaN },
    { end: Number.POSITIVE_INFINITY },
    { kind: 'extend' as const, extension: 0 },
    { kind: 'extend' as const, extension: 11 },
    { kind: 'extend' as const, extension: Number.NaN },
    { kind: 'extend' as const },
    { id: 'original' },
  ])('rejects invalid edit input %j', (invalid) => {
    expect(() => applyEdit(createOriginalVersion(15), { ...edit, ...invalid })).toThrow(RangeError)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid source duration %s',
    (duration) => {
      expect(() => createOriginalVersion(duration)).toThrow(RangeError)
    },
  )

  it('does not mutate ancestor versions or share mutable segment objects', () => {
    const original = createOriginalVersion(15)
    const v2 = applyEdit(original, edit)
    const before = JSON.stringify([original, v2])
    const v3 = applyEdit(v2, { ...edit, id: 'v3', label: 'V3', start: 5, end: 7 })

    expect(JSON.stringify([original, v2])).toBe(before)
    expect(Object.isFrozen(v3)).toBe(true)
    expect(Object.isFrozen(v3.segments)).toBe(true)
    expect(v3.segments.every((segment) => Object.isFrozen(segment))).toBe(true)
    expect(v3.segments.some((segment) => v2.segments.includes(segment))).toBe(false)
  })
})
