/** 一张卡要显示的派生量：画幅比例、时长、正文开头。都从接口字段推，不读媒体本身。 */

import type { LibraryTake, LibraryVideo } from './library.api'

/** 画面尺寸不在数据里，占位按请求里的画幅；认不出的（如 adaptive）按竖版 9:16 占位。 */
const FALLBACK_ASPECT = { h: 16, w: 9 } as const

const RATIO = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/

export const aspectOf = (aspectRatio: string | null): { w: number; h: number } => {
  const match = aspectRatio === null ? null : RATIO.exec(aspectRatio)
  const w = Number(match?.[1])
  const h = Number(match?.[2])
  return w > 0 && h > 0 ? { h, w } : FALLBACK_ASPECT
}

/** 这张卡的秒数：成片量出来的时长优先，其次请求里的秒数，再次分镜的末尾；都没有是 null。 */
export const durationSecondsOf = (video: LibraryVideo): number | null => {
  if (video.face.durationMs !== null) return video.face.durationMs / 1000
  if (video.take.seconds !== null && video.take.seconds > 0) return video.take.seconds
  return video.take.script?.timeline.at(-1)?.end ?? null
}

/** 分:秒，秒数补两位；不足一秒按一秒算，免得出现 0:00。 */
export const formatClock = (seconds: number): string => {
  const total = Math.max(1, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 卡上悬停时露出的那段话：第一镜的正文，纯文本就是原文开头；参考图记号去掉。 */
export const openingTextOf = (take: LibraryTake): string => {
  const text = take.script?.timeline[0]?.prompt ?? take.prompt
  return text.replace(/@Image\d+\s?/g, '').trim()
}

/** 卡片标题：来源对话的标题加镜头组号；不挂对话的出片是接口调用方直接交的。 */
export const cardTitleOf = (video: LibraryVideo): string =>
  `${video.title ?? '接口提交'}${video.shotIndex === null ? '' : ` · 镜头组 ${video.shotIndex}`}`

/** 镜头数：有分镜就是分镜的镜数，纯文本没有镜的概念。 */
export const cutCountOf = (take: LibraryTake): number | null =>
  take.script === null ? null : take.script.timeline.length
