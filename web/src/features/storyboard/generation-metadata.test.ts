import { describe, expect, it } from 'vitest'
import {
  metadataFilterParam,
  readStoryboardMetadata,
  storyboardMetadata,
} from './generation-metadata'

describe('storyboardMetadata', () => {
  it('视频按镜头组，图片多一个帧号', () => {
    expect(storyboardMetadata(2)).toEqual({ shot: 2 })
    expect(storyboardMetadata(2, 3)).toEqual({ frame: 3, shot: 2 })
  })
})

describe('readStoryboardMetadata', () => {
  it('分镜页写的形状原样读回', () => {
    expect(readStoryboardMetadata({ metadata: { shot: 1, frame: 2 } })).toEqual({
      frame: 2,
      shot: 1,
    })
  })

  it('只发 shot_index 的调用方，服务端折出来的坐标也读得出来', () => {
    expect(readStoryboardMetadata({ metadata: { shot: 3 } })).toEqual({ shot: 3 })
  })

  it.each([
    ['没有坐标', null],
    ['别的调用方的形状', { batch: 'x' }],
    ['帧号不是正整数', { shot: 1, frame: 0 }],
    ['视频编辑链的形状', { rootJob: 'a', baseJob: 'a', editId: 'e', editStart: 0, editEnd: 1 }],
  ])('%s 就当没有坐标', (_name, metadata) => {
    expect(readStoryboardMetadata({ metadata })).toBeUndefined()
  })
})

describe('metadataFilterParam', () => {
  it('筛选参数是 JSON 对象，按给的键包含匹配', () => {
    expect(JSON.parse(metadataFilterParam({ shot: 1, frame: 2 }))).toEqual({ frame: 2, shot: 1 })
  })
})
