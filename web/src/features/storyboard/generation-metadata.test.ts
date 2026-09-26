import { describe, expect, it } from 'vitest'
import { readStoryboardMetadata } from './generation-metadata'

describe('readStoryboardMetadata', () => {
  it('分镜页写的形状原样读回', () => {
    expect(readStoryboardMetadata({ metadata: { shot: 1, frame: 2 } })).toEqual({
      frame: 2,
      shot: 1,
    })
  })

  it('坐标以外的键不读', () => {
    expect(
      readStoryboardMetadata({
        metadata: { shot: 1, frame: 2, sourceUrl: 'https://cdn.test/base.png' },
      }),
    ).toEqual({ frame: 2, shot: 1 })
  })

  it.each([
    ['没有坐标', null],
    ['别的调用方的形状', { batch: 'x' }],
    ['帧号不是正整数', { shot: 1, frame: 0 }],
  ])('%s 就当没有坐标', (_name, metadata) => {
    expect(readStoryboardMetadata({ metadata })).toBeUndefined()
  })
})
