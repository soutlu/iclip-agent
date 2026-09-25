import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { isShotVideo, phaseOfStatus } from './shots'

describe('phaseOfStatus', () => {
  it.each([
    ['pending', 'queued'],
    ['submitting', 'running'],
    ['submitted', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
  ] as const)('%s 给人看是 %s', (status, phase) => {
    expect(phaseOfStatus(status)).toBe(phase)
  })
})

describe('isShotVideo', () => {
  const take = makeGenerationJob({ id: 'take', shotIndex: 2 })

  it('镜号是这一组的出片算这一组', () => {
    expect(isShotVideo(take, 2)).toBe(true)
    expect(isShotVideo(take, 3)).toBe(false)
  })

  it.each([
    [
      '编辑段',
      makeGenerationJob({
        shotIndex: 2,
        rootJobId: 'take',
        sourceJobId: 'take',
        rangeStartMs: 0,
        rangeEndMs: 3000,
      }),
    ],
    [
      '合成',
      makeGenerationJob({
        operation: 'compose',
        shotIndex: 2,
        rootJobId: 'take',
        sourceJobId: 'edit',
      }),
    ],
    ['只在 metadata 里写了 shot 的视频', makeGenerationJob({ metadata: { shot: 2 } })],
  ])('%s 不算这一组的出片', (_name, job) => {
    expect(isShotVideo(job, 2)).toBe(false)
  })
})
