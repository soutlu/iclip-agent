import { useEffect, useMemo, useRef, useState } from 'react'

/** 各地址的时长（秒）；`null` 是读不到。没探过的不在里面。 */
export type MediaDurations = Readonly<Record<string, number | null>>

/** 用一个不上屏的 `<video preload="metadata">` 读每条素材的时长。
 *
 * 上游给的地址跨域，前端读不到字节，这是唯一能拿到时长的口子；预览与合成要靠它把开放着的
 * 段落实成区间。同一地址只探一遍。
 *
 * `known` 是后端已经量好的时长（秒），这些地址不再探——本系统自己加工出来的视频，后端是
 * 权威。 */
export const useMediaDurations = (
  urls: readonly string[],
  known: Readonly<Record<string, number>> = {},
): MediaDurations => {
  const [durations, setDurations] = useState<MediaDurations>({})
  const probingRef = useRef(new Set<string>())

  useEffect(() => {
    for (const url of urls) {
      if (url in known || url in durations || probingRef.current.has(url)) continue
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
  }, [urls, known, durations])

  // 合出来的表要稳住：它是下游 memo 与「切好就发」那个 effect 的依赖，每帧换对象就每帧重跑。
  return useMemo(() => ({ ...durations, ...known }), [durations, known])
}
