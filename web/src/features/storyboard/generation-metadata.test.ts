import { describe, expect, it } from 'vitest'
import {
  metadataFilterParam,
  readStoryboardMetadata,
  storyboardMetadata,
} from './generation-metadata'

describe('storyboardMetadata', () => {
  it('视频按镜头组，图片多一个帧号', () => {
    expect(storyboardMetadata('video_shot.json', 2)).toEqual({ path: 'video_shot.json', shot: 2 })
    expect(storyboardMetadata('video_shot.json', 2, 3)).toEqual({
      frame: 3,
      path: 'video_shot.json',
      shot: 2,
    })
  })
})

describe('readStoryboardMetadata', () => {
  it('分镜页写的形状原样读回', () => {
    expect(
      readStoryboardMetadata({ metadata: { path: 'video_shot.json', shot: 1, frame: 2 } }),
    ).toEqual({ frame: 2, path: 'video_shot.json', shot: 1 })
  })

  it.each([
    ['没有坐标', null],
    ['别的调用方的形状', { batch: 'x' }],
    ['帧号不是正整数', { path: 'video_shot.json', shot: 1, frame: 0 }],
    ['缺路径', { shot: 1 }],
  ])('%s 就当没有坐标', (_name, metadata) => {
    expect(readStoryboardMetadata({ metadata })).toBeUndefined()
  })
})

describe('metadataFilterParam', () => {
  it('筛选参数是 JSON 对象，按给的键包含匹配', () => {
    expect(JSON.parse(metadataFilterParam({ shot: 1, frame: 2 }))).toEqual({ frame: 2, shot: 1 })
  })
})
