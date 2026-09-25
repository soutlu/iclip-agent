import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { groupConversationVideos } from './video-groups'

const job = (id: string, overrides: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({
    id,
    outputUrl: `${id}.mp4`,
    metadata: { shot: 1 },
    createdAt: '2026-09-01T10:00:00Z',
    ...overrides,
  })

describe('groupConversationVideos', () => {
  it('只收成功、有地址的原始视频，图片、编辑段与合成均不计入版本', () => {
    const groups = groupConversationVideos([
      job('original'),
      job('image', { kind: 'image' }),
      job('failed', { status: 'failed' }),
      job('submitted', { status: 'submitted' }),
      job('empty', { outputUrl: null }),
      job('blank', { outputUrl: '  ' }),
      // 坐标照样落在这一组上，靠来源认出它们不是出片。
      job('edited', {
        rootJobId: 'original',
        sourceJobId: 'original',
        rangeStartMs: 0,
        rangeEndMs: 3000,
      }),
      job('composite', { operation: 'compose', rootJobId: 'original', sourceJobId: 'edited' }),
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
