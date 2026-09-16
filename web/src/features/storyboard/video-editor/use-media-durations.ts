import { useEffect, useRef, useState } from 'react'

/** 各地址的时长（秒）；`null` 是读不到。没探过的不在里面。 */
export type MediaDurations = Readonly<Record<string, number | null>>

/** 用一个不上屏的 `<video preload="metadata">` 读每条素材的时长。
 *
 * 前端读不到视频字节（地址跨域），这是唯一能拿到时长的口子。参考片段的实际时长要靠它反算
 * 关键帧起点；预览与合成要靠它把开放着的段落实成区间。同一地址只探一遍。 */
export const useMediaDurations = (urls: readonly string[]): MediaDurations => {
  const [durations, setDurations] = useState<MediaDurations>({})
  const probingRef = useRef(new Set<string>())

  useEffect(() => {
    for (const url of urls) {
      if (url in durations || probingRef.current.has(url)) continue
      probingRef.current.add(url)
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      const settle = (value: number | null) => {
        video.onloadedmetadata = null
        video.onerror = null
        setDurations((current) => ({ ...current, [url]: value }))
        video.removeAttribute('src')
        video.load()
      }
      video.onloadedmetadata = () => settle(Number.isFinite(video.duration) ? video.duration : null)
      video.onerror = () => settle(null)
      video.src = url
    }
  }, [urls, durations])

  return durations
}
