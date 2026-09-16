import { describe, expect, it } from 'vitest'
import type { GenerationJob } from '../storyboard.api'
import { entryBaseUrl, frameImageEntries } from './edit-history'

const CURRENT = 'https://cdn.test/current.png'

const job = (over: Partial<GenerationJob> & { id: string; createdAt: string }): GenerationJob => ({
  kind: 'image',
  status: 'completed',
  errorMessage: null,
  outputUrl: null,
  metadata: { path: 'video_shot.json', shot: 1, frame: 1 },
  request: {},
  taskId: null,
  clipStage: null,
  durationMs: null,
  watermarkOutputUrl: null,
  ...over,
})

function at(entries: ReturnType<typeof frameImageEntries>, position: number) {
  const entry = entries[position]
  if (entry === undefined) throw new Error(`第 ${position + 1} 格不存在`)
  return entry
}

describe('frameImageEntries', () => {
  it('当前帧固定在头一个，其余按时间倒序', () => {
    const entries = frameImageEntries(
      [
        job({ id: 'old', createdAt: '2026-09-13T01:00:00Z', outputUrl: 'https://cdn.test/a.png' }),
        job({ id: 'new', createdAt: '2026-09-13T03:00:00Z', outputUrl: 'https://cdn.test/b.png' }),
      ],
      CURRENT,
    )
    expect(entries.map((entry) => entry.key)).toEqual(['current', 'new', 'old'])
    expect(at(entries, 0)).toMatchObject({ kind: 'current', url: CURRENT, job: null })
  })

  it('结果已经是当前帧那张时折进当前帧格，带上产出它的任务', () => {
    const applied = job({ id: 'applied', createdAt: '2026-09-13T02:00:00Z', outputUrl: CURRENT })
    const entries = frameImageEntries([applied], CURRENT)
    expect(entries).toHaveLength(1)
    expect(at(entries, 0)).toMatchObject({ kind: 'current', url: CURRENT, job: applied })
  })

  it('只在别人底图里出现过的图也进条，键用地址，没有产出它的任务', () => {
    const entries = frameImageEntries(
      [
        job({
          id: 'j1',
          createdAt: '2026-09-13T02:00:00Z',
          outputUrl: 'https://cdn.test/b.png',
          metadata: {
            path: 'video_shot.json',
            shot: 1,
            frame: 1,
            sourceUrl: 'https://cdn.test/gone.png',
          },
        }),
      ],
      CURRENT,
    )
    expect(entries.map((entry) => entry.key)).toEqual([
      'current',
      'j1',
      'https://cdn.test/gone.png',
    ])
    expect(at(entries, 2)).toMatchObject({ kind: 'image', job: null })
  })

  it('同一张图既是产出又被后来当底图时，留下产出它的那条任务', () => {
    const entries = frameImageEntries(
      [
        job({
          id: 'second',
          createdAt: '2026-09-13T03:00:00Z',
          outputUrl: 'https://cdn.test/c.png',
          metadata: {
            path: 'video_shot.json',
            shot: 1,
            frame: 1,
            sourceUrl: 'https://cdn.test/b.png',
          },
        }),
        job({
          id: 'first',
          createdAt: '2026-09-13T02:00:00Z',
          outputUrl: 'https://cdn.test/b.png',
        }),
      ],
      CURRENT,
    )
    expect(entries.map((entry) => entry.key)).toEqual(['current', 'second', 'first'])
  })

  it.each([
    ['pending', 'pending'],
    ['submitted', 'pending'],
    ['failed', 'failed'],
  ])('没有产出的任务照样占一格：%s', (status, kind) => {
    const entries = frameImageEntries(
      [job({ id: 'live', createdAt: '2026-09-13T04:00:00Z', status })],
      CURRENT,
    )
    expect(entries.map((entry) => entry.kind)).toEqual(['current', kind])
  })

  it('一条任务都没有时只有当前帧', () => {
    expect(frameImageEntries([], CURRENT)).toEqual([
      { kind: 'current', key: 'current', url: CURRENT, job: null },
    ])
  })
})

describe('entryBaseUrl', () => {
  it('在跑的任务落回它当初的底图', () => {
    const entries = frameImageEntries(
      [
        job({
          id: 'live',
          createdAt: '2026-09-13T04:00:00Z',
          status: 'submitted',
          metadata: {
            path: 'video_shot.json',
            shot: 1,
            frame: 1,
            sourceUrl: 'https://cdn.test/base.png',
          },
        }),
      ],
      CURRENT,
    )
    expect(entryBaseUrl(at(entries, 1), CURRENT)).toBe('https://cdn.test/base.png')
  })

  it('存量任务没记底图时落回当前帧', () => {
    const entries = frameImageEntries(
      [job({ id: 'live', createdAt: '2026-09-13T04:00:00Z', status: 'failed' })],
      CURRENT,
    )
    expect(entryBaseUrl(at(entries, 1), CURRENT)).toBe(CURRENT)
  })
})
