import { describe, expect, it } from 'vitest'
import { frameBadges, latestFrameJobs } from './frame-status'
import type { Shot } from './shot-document'
import type { GenerationJob } from './storyboard.api'

const ORIGINAL = 'https://example.com/original.png'
const EDITED = 'https://example.com/edited.png'

const job = (
  overrides: Partial<GenerationJob> & { frameNumber?: number | undefined },
): GenerationJob => {
  const { frameNumber, ...rest } = overrides
  return {
    id: crypto.randomUUID(),
    kind: 'image',
    shotIndex: 1,
    status: 'completed',
    createdAt: '2026-09-07T12:00:00Z',
    errorMessage: null,
    outputUrl: EDITED,
    request: frameNumber === undefined ? { prompt: '换色' } : { frameNumber, prompt: '换色' },
    taskId: null,
    watermarkOutputUrl: null,
    ...rest,
  }
}

const shot: Shot = {
  index: 1,
  seconds: 6,
  image_urls: [ORIGINAL, 'https://example.com/two.png'],
  prompt: {
    global_settings: '人物保持一致。',
    timeline: [{ timestamps: [0, 6], prompt: '走向镜头 @Image1。', image_indexes: [1] }],
  },
}

describe('latestFrameJobs', () => {
  it('每格取最新一条，不依赖服务端给的顺序', () => {
    const older = job({ id: 'older', frameNumber: 1, createdAt: '2026-09-07T10:00:00Z' })
    const newer = job({ id: 'newer', frameNumber: 1, createdAt: '2026-09-07T11:00:00Z' })
    const other = job({ id: 'other', frameNumber: 2, shotIndex: 2 })

    const latest = latestFrameJobs([older, other, newer])

    expect(latest.get('1:1')?.id).toBe('newer')
    expect(latest.get('2:2')?.id).toBe('other')
    expect(latest.size).toBe(2)
  })

  it('视频任务、没标镜头组或帧号的记录落不到格上', () => {
    const latest = latestFrameJobs([
      job({ kind: 'video', frameNumber: 1 }),
      job({ shotIndex: null, frameNumber: 1 }),
      job({ frameNumber: undefined }),
    ])

    expect(latest.size).toBe(0)
  })
})

describe('frameBadges', () => {
  const badgesOf = (item: GenerationJob, seen: string[] = []) =>
    frameBadges(shot, latestFrameJobs([item]), new Set(seen))

  it.each([
    ['pending', 'queued'],
    ['submitted', 'running'],
  ])('%s 的任务在帧上显示 %s，看过也照样显示', (status, kind) => {
    const item = job({ status, frameNumber: 1, outputUrl: null })
    expect(badgesOf(item).get(1)).toEqual({ kind })
    expect(badgesOf(item, [item.id]).get(1)).toEqual({ kind })
  })

  it('失败带原因；看过一次就清', () => {
    const item = job({
      status: 'failed',
      frameNumber: 1,
      outputUrl: null,
      errorMessage: '上游超时',
    })
    expect(badgesOf(item).get(1)).toEqual({ kind: 'failed', message: '上游超时' })
    expect(badgesOf(item, [item.id]).has(1)).toBe(false)
  })

  it('完成且结果不是当前帧才算有新结果；已采用或看过就不显示', () => {
    const fresh = job({ frameNumber: 1 })
    expect(badgesOf(fresh).get(1)).toEqual({ kind: 'result' })
    expect(badgesOf(fresh, [fresh.id]).has(1)).toBe(false)
    expect(badgesOf(job({ frameNumber: 1, outputUrl: ORIGINAL })).has(1)).toBe(false)
    expect(badgesOf(job({ frameNumber: 1, outputUrl: null })).has(1)).toBe(false)
  })

  it('只挂在这一组现有的帧上', () => {
    expect(badgesOf(job({ frameNumber: 3 })).size).toBe(0)
    expect(badgesOf(job({ frameNumber: 1, shotIndex: 2 })).size).toBe(0)
  })
})
