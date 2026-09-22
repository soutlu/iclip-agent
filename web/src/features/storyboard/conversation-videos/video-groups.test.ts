import { describe, expect, it } from 'vitest'
import type { GenerationJob } from '../storyboard.api'
import { groupConversationVideos } from './video-groups'

const job = (id: string, overrides: Partial<GenerationJob> = {}): GenerationJob => ({
  id,
  kind: 'video',
  status: 'completed',
  outputUrl: `${id}.mp4`,
  watermarkOutputUrl: null,
  metadata: { shot: 1 },
  createdAt: '2026-09-01T10:00:00Z',
  request: {},
  taskId: null,
  rootJobId: null,
  errorMessage: null,
  clipStage: null,
  durationMs: null,
  ...overrides,
})

describe('groupConversationVideos', () => {
  it('只收成功、有地址的原始视频，图片、切片和编辑结果均不计入版本', () => {
    const groups = groupConversationVideos([
      job('original'),
      job('image', { kind: 'image' }),
      job('clip', { kind: 'clip' }),
      job('failed', { status: 'failed' }),
      job('submitted', { status: 'submitted' }),
      job('empty', { outputUrl: null }),
      job('blank', { outputUrl: '  ' }),
      job('edited', {
        rootJobId: 'original',
        metadata: { shot: 1, baseJob: 'original', editId: 'edit', editStart: 0, editEnd: 3 },
      }),
    ])

    expect(groups.map((group) => group.videos.map((video) => video.id))).toEqual([['original']])
  })

  it('按镜号归组排序，每组版本按创建时间与 id 稳定地从旧到新排列', () => {
    const records = [
      job('second-shot', { metadata: { shot: 2 } }),
      job('c', { createdAt: '2026-09-01T11:00:00Z' }),
      job('b'),
      job('a'),
    ]
    const groups = groupConversationVideos(records)

    expect(groups.map((group) => group.label)).toEqual(['镜头组 1', '镜头组 2'])
    expect(groups[0]?.videos.map((video) => video.id)).toEqual(['a', 'b', 'c'])
    expect(groupConversationVideos(records.toReversed())).toEqual(groups)
  })

  it.each([null, {}, { shot: '1' }, { shot: 0 }, { shot: -1 }, { shot: 1.5 }])(
    '坐标 %j 没有合法镜号时，每条视频独立展示',
    (metadata) => {
      const groups = groupConversationVideos([job('a', { metadata }), job('b', { metadata })])

      expect(groups.map((group) => group.label)).toEqual(['视频 1', '视频 2'])
      expect(groups.map((group) => group.videos.map((video) => video.id))).toEqual([['a'], ['b']])
    },
  )
})
