/** 卡片与详情要显示的派生量：画幅、时长、正文、故事板取帧、版本。都从接口字段推，不读媒体本身。 */

import type {
  LibraryScript,
  LibraryShotGroup,
  LibraryTake,
  LibraryVersionOut,
  LibraryVideo,
} from './library.api'

/** 画面尺寸不在数据里，占位按请求里的画幅；认不出的（如 adaptive）按竖版 9:16 占位。 */
const FALLBACK_ASPECT = { h: 16, w: 9 } as const

const RATIO = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/

export const aspectOf = (aspectRatio: string | null): { w: number; h: number } => {
  const match = aspectRatio === null ? null : RATIO.exec(aspectRatio)
  const w = Number(match?.[1])
  const h = Number(match?.[2])
  return w > 0 && h > 0 ? { h, w } : FALLBACK_ASPECT
}

/** 一版的秒数：这一版量出来的时长（只有合成有）优先，其次它对应那次出片请求里的秒数，再次分镜的末尾；都没有是 null。 */
export const durationSecondsOf = (durationMs: number | null, take: LibraryTake): number | null => {
  if (durationMs !== null) return durationMs / 1000
  if (take.seconds !== null && take.seconds > 0) return take.seconds
  return take.script?.timeline.at(-1)?.end ?? null
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

/** 卡片标题：来源对话的标题；不挂对话的出片是接口调用方直接交的。 */
export const cardTitleOf = (video: LibraryVideo): string => video.title ?? '接口提交'

/** 镜头数：有分镜就是分镜的镜数，纯文本没有镜的概念。 */
export const cutCountOf = (take: LibraryTake): number | null =>
  take.script === null ? null : take.script.timeline.length

/** 秒数的短写：最多一位小数，去掉多余的零，如 3.5、10。 */
export const formatSecond = (seconds: number): string => String(Math.round(seconds * 10) / 10)

/** 故事板的一格：这一段的起止与取帧时刻；有分镜时带这一镜的正文。 */
export type Keyframe = {
  index: number
  start: number
  end: number
  at: number
  prompt: string | null
}

/** 纯文本按时长均匀取几帧：大约两秒一帧，最少 4 帧、最多 8 帧。 */
const uniformFrameCount = (seconds: number): number =>
  Math.min(8, Math.max(4, Math.round(seconds / 2)))

/** 有分镜就每镜在中点取一帧；纯文本按时长均匀取帧；时长也不知道就没有故事板。 */
export const keyframesOf = (take: LibraryTake, seconds: number | null): Keyframe[] => {
  if (take.script !== null) {
    return take.script.timeline.map((cut, order) => ({
      at: (cut.start + cut.end) / 2,
      end: cut.end,
      index: order + 1,
      prompt: cut.prompt,
      start: cut.start,
    }))
  }
  if (seconds === null || seconds <= 0) return []
  const count = uniformFrameCount(seconds)
  const span = seconds / count
  return Array.from({ length: count }, (_, order) => ({
    at: (order + 0.5) * span,
    end: (order + 1) * span,
    index: order + 1,
    prompt: null,
    start: order * span,
  }))
}

/** 正文按参考图记号切段：`@ImageN` 指第 N 张参考图，超出张数的只当文字。`start` 是这段在原文里的位置。 */
export type PromptSegment = { start: number } & (
  { kind: 'text'; text: string } | { kind: 'image'; number: number; url: string }
)

export const promptSegmentsOf = (
  text: string,
  referenceImageUrls: readonly string[],
): PromptSegment[] => {
  const segments: PromptSegment[] = []
  let start = 0
  for (const part of text.split(/(@Image\d+)/)) {
    if (part !== '') {
      const number = Number(/^@Image(\d+)$/.exec(part)?.[1])
      const url = number > 0 ? referenceImageUrls[number - 1] : undefined
      segments.push(
        url === undefined
          ? { kind: 'text', start, text: part }
          : { kind: 'image', number, start, url },
      )
    }
    start += part.length
  }
  return segments
}

/** 此刻落在哪一镜：起点含、终点不含；不在任何一镜里是 -1。 */
export const cutIndexAt = (script: LibraryScript, seconds: number): number =>
  script.timeline.findIndex((cut) => seconds >= cut.start && seconds < cut.end)

/** 详情里能切换的一个版本：一条出片或合成，带上它在组里的名字。参数与脚本取自它对应的那次出片。 */
export type LibraryVersion = LibraryVersionOut & { label: string }

/** 一个镜头组的全部版本：接口已按完成先后排好，第 N 条叫「第 N 版」，出片与合成一起数。 */
export const versionsOf = (group: LibraryShotGroup): LibraryVersion[] =>
  group.versions.map((version, order) => ({ ...version, label: `第 ${order + 1} 版` }))

/** 组卡上的名字：有镜号是「镜头组 N」，没有就是「无镜号」。 */
export const groupLabelOf = (group: LibraryShotGroup): string =>
  group.shotIndex === null ? '无镜号' : `镜头组 ${group.shotIndex}`
