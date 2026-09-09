import { describe, expect, it } from 'vitest'
import {
  latestShotVideos,
  runningShots,
  shotStatus,
  splitPrompt,
  type ShotGeneration,
} from './shots'

const job = (overrides: Partial<ShotGeneration>): ShotGeneration => ({
  createdAt: '2026-09-01T10:00:00Z',
  kind: 'video',
  outputUrl: 'https://cdn.example/v1.mp4',
  shotIndex: 1,
  status: 'completed',
  ...overrides,
})

describe('splitPrompt', () => {
  it('帧记号切成独立段，正文与换行原样留着', () => {
    expect(
      splitPrompt('开场 @Image1，\n收尾 @Image12。').map(({ id: _id, ...segment }) => segment),
    ).toEqual([
      { kind: 'text', text: '开场 ' },
      { kind: 'frame', number: 1 },
      { kind: 'text', text: '，\n收尾 ' },
      { kind: 'frame', number: 12 },
      { kind: 'text', text: '。' },
    ])
  })

  it('每段的 id 各不相同，渲染时当 key 用', () => {
    const ids = splitPrompt('同 @Image1 同 @Image1 同').map((segment) => segment.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('没有帧记号就只有一段正文', () => {
    expect(splitPrompt('只有正文')).toEqual([{ id: 't0', kind: 'text', text: '只有正文' }])
  })
})

describe('latestShotVideos', () => {
  it('每组取最新一条完成的视频', () => {
    const videos = latestShotVideos([
      job({ createdAt: '2026-09-01T09:00:00Z', outputUrl: 'old.mp4' }),
      job({ createdAt: '2026-09-01T11:00:00Z', outputUrl: 'new.mp4' }),
      job({ createdAt: '2026-09-01T12:00:00Z', outputUrl: 'other.mp4', shotIndex: 2 }),
    ])

    expect(videos.get(1)).toBe('new.mp4')
    expect(videos.get(2)).toBe('other.mp4')
  })

  it('没完成的、出图的、没归组的都不算', () => {
    const videos = latestShotVideos([
      job({ status: 'submitted' }),
      job({ kind: 'image', outputUrl: 'frame.png' }),
      job({ shotIndex: null }),
      job({ outputUrl: null }),
    ])

    expect(videos.size).toBe(0)
  })
})

describe('shotStatus', () => {
  it('出过片是成功档，在飞是运行档，都没有是中性', () => {
    const jobs = [job({ shotIndex: 1 }), job({ shotIndex: 2, status: 'submitting' })]
    const videos = latestShotVideos(jobs)
    const running = runningShots(jobs)

    expect(shotStatus(1, videos, running)).toBe('ready')
    expect(shotStatus(2, videos, running)).toBe('running')
    expect(shotStatus(3, videos, running)).toBe('idle')
  })

  it('既有成片又在重出时仍算成功档', () => {
    const jobs = [job({}), job({ createdAt: '2026-09-01T13:00:00Z', status: 'pending' })]
    expect(shotStatus(1, latestShotVideos(jobs), runningShots(jobs))).toBe('ready')
  })
})
