import { describe, expect, it } from 'vitest'
import { videoSnapshotUrl } from './media-url'

const OSS = 'https://bucket.oss-cn-shenzhen.aliyuncs.com/out/a.mp4'

describe('videoSnapshotUrl', () => {
  it('首帧走快速模式，只按宽度缩放', () => {
    expect(videoSnapshotUrl(OSS, 360)).toBe(
      `${OSS}?x-oss-process=video/snapshot,t_0,f_jpg,w_360,h_0,m_fast`,
    )
  })

  it('指定时刻时精确截帧，毫秒取整', () => {
    expect(videoSnapshotUrl(OSS, 240, 1.2345)).toBe(
      `${OSS}?x-oss-process=video/snapshot,t_1235,f_jpg,w_240,h_0`,
    )
  })

  it.each(['https://example.com/a.mp4', `${OSS}?Expires=1`, 'blob:http://localhost/1'])(
    '不是无参数的 OSS 地址就不截帧：%s',
    (url) => {
      expect(videoSnapshotUrl(url, 240, 3)).toBeUndefined()
    },
  )
})
