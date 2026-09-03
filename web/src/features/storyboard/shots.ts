/**
 * `video_shot.json` 的读法：解析、组名、每组的成片与状态。
 *
 * 键名照 `write_video_shots` 落文件那一份（`aspectRatio` / `shots[].imageUrls`，其余 camelCase），
 * 不是接口合同的一部分——它是工作区里的一份 JSON，形状由交付它的工具定。
 */

import { z } from 'zod'

export const SHOTS_PATH = 'video_shot.json'

const shotSchema = z.object({
  imageUrls: z.array(z.string()),
  index: z.int(),
  prompt: z.string(),
  seconds: z.number(),
})

const shotsDocumentSchema = z.object({
  aspectRatio: z.string(),
  shots: z.array(shotSchema),
})

export type Shot = z.infer<typeof shotSchema>
export type ShotsDocument = z.infer<typeof shotsDocumentSchema>

/**
 * 解析一份 `video_shot.json`。
 *
 * @param content - 文件正文。
 * @returns 解析结果；不是 JSON 或形状对不上时为 null（界面据此显示「文件格式不对」）。
 */
export const parseShotsDocument = (content: string): ShotsDocument | null => {
  const parsed = shotsDocumentSchema.safeParse(
    ((): unknown => {
      try {
        return JSON.parse(content)
      } catch {
        return null
      }
    })(),
  )
  return parsed.success ? parsed.data : null
}

/** 画幅换成 CSS 的写法：`9:16` → `9 / 16`。 */
export const aspectRatioStyle = (aspectRatio: string) => aspectRatio.replace(':', ' / ')

const FRAME_REF = /@Image(\d+)/g

/** 组名截到几个字。再长胶片条那一行就换行了。 */
const NAME_CHARS = 12

/**
 * 组名：prompt 时间线第一段的前 12 字，取不出就叫「镜头组 N」。
 *
 * @param shot - 一个镜头组。
 * @returns 组名。
 */
export const shotName = (shot: Shot): string => {
  const firstLine = shot.prompt
    .split('\n')
    .map((line) => line.replace(FRAME_REF, '').trim())
    .find((line) => line.length > 0)
  return firstLine === undefined || firstLine.length === 0
    ? `镜头组 ${shot.index}`
    : firstLine.slice(0, NAME_CHARS)
}

/** `id` 是这一段在原文里的起始位置，渲染时当 key 用——正文可能逐字重复，位置不会。 */
export type PromptSegment =
  { id: string; kind: 'text'; text: string } | { id: string; kind: 'frame'; number: number }

/**
 * 把 prompt 切成正文与帧记号两种段落，`@ImageN` 在界面上画成芯片。
 *
 * @param prompt - 一个镜头组的 prompt 原文。
 * @returns 按原次序排好的段落；换行留在正文里。
 */
export const splitPrompt = (prompt: string): PromptSegment[] => {
  const segments: PromptSegment[] = []
  let cursor = 0
  for (const match of prompt.matchAll(FRAME_REF)) {
    const at = match.index
    if (at > cursor) {
      segments.push({ id: `t${cursor}`, kind: 'text', text: prompt.slice(cursor, at) })
    }
    segments.push({ id: `f${at}`, kind: 'frame', number: Number(match[1]) })
    cursor = at + match[0].length
  }
  if (cursor < prompt.length) {
    segments.push({ id: `t${cursor}`, kind: 'text', text: prompt.slice(cursor) })
  }
  return segments
}

/** 一次生成任务里这个界面用得上的那几列。 */
export interface ShotGeneration {
  createdAt: string
  kind: string
  outputUrl: string | null
  shotIndex: number | null
  status: string
}

/** 还在飞的那几档：排着、正在提交、已提交给 provider。 */
const IN_FLIGHT = new Set(['pending', 'submitting', 'submitted'])

/**
 * 每组当前显示哪条视频：按 `shotIndex` 分组，取最新一条完成的。
 *
 * @param jobs - 这段对话的生成任务。
 * @returns 组号到视频地址的表。
 */
export const latestShotVideos = (jobs: readonly ShotGeneration[]): Map<number, string> => {
  const latest = new Map<number, { at: string; url: string }>()
  for (const job of jobs) {
    if (job.kind !== 'video' || job.status !== 'completed') continue
    if (job.shotIndex === null || job.outputUrl === null) continue
    const current = latest.get(job.shotIndex)
    if (current === undefined || current.at < job.createdAt) {
      latest.set(job.shotIndex, { at: job.createdAt, url: job.outputUrl })
    }
  }
  return new Map([...latest].map(([index, take]) => [index, take.url]))
}

/** 还在飞的那几组。 */
export const runningShots = (jobs: readonly ShotGeneration[]): Set<number> =>
  new Set(
    jobs.flatMap((job) =>
      job.kind === 'video' && job.shotIndex !== null && IN_FLIGHT.has(job.status)
        ? [job.shotIndex]
        : [],
    ),
  )

export type ShotStatus = 'ready' | 'running' | 'idle'

/**
 * 胶片条上那个状态圆点。出过片优先于在飞：已经有成片可看了。
 *
 * @param index - 第几组。
 * @param videos - 每组当前的成片。
 * @param running - 还在飞的那几组。
 * @returns 圆点档位。
 */
export const shotStatus = (
  index: number,
  videos: ReadonlyMap<number, string>,
  running: ReadonlySet<number>,
): ShotStatus => {
  if (videos.has(index)) return 'ready'
  return running.has(index) ? 'running' : 'idle'
}
