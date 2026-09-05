/** video_shot.json 由 write_video_shots 工具定义，独立于 REST 合同。 */

import { z } from 'zod'
import type { WorkbenchRef } from '@/shared/workbench'

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

export const aspectRatioStyle = (aspectRatio: string) => aspectRatio.replace(':', ' / ')

const FRAME_REF = /@Image(\d+)/g

/** 组名取首个句末标点前的正文，视觉截断交给界面。 */
const SENTENCE_END = /[。；！？!?;]/

/** 以原文起始位置作为 key，避免重复正文产生冲突。 */
export type PromptSegment =
  { id: string; kind: 'text'; text: string } | { id: string; kind: 'frame'; number: number }

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

/** 时间线头接受 - 和 – 两种分隔符，并保留小数秒。 */
const SCENE_HEADER =
  /^[ \t]*[[【][ \t]*(\d+(?:\.\d+)?)[ \t]*[–-][ \t]*(\d+(?:\.\d+)?)[ \t]*秒?[ \t]*[|｜][ \t]*镜头[ \t]*(\d+)[ \t]*[\]】][ \t]*$/

export const isSceneHeader = (line: string): boolean => SCENE_HEADER.test(line)

export const parseSceneHeader = (
  line: string,
): { startSeconds: number; endSeconds: number; scene: number } | undefined => {
  const header = SCENE_HEADER.exec(line)
  if (header === null) return undefined
  return {
    endSeconds: Number(header[2]),
    scene: Number(header[3]),
    startSeconds: Number(header[1]),
  }
}

export interface ShotScene {
  /** 使用行号作为 key，容忍模型输出重复镜头号。 */
  id: string
  scene: number
  startSeconds: number
  endSeconds: number
  segments: PromptSegment[]
  /** 按出现顺序返回去重后的帧编号。 */
  frameNumbers: number[]
}

export interface ShotTimeline {
  preamble: string
  scenes: ShotScene[]
}

/** 时间线头划分镜头；没有头时整段作为前言，界面显示完整描述。 */
export const splitShotTimeline = (shot: Shot): ShotTimeline => {
  const preamble: string[] = []
  const scenes: ShotScene[] = []
  let body: string[] = []

  const flush = () => {
    const current = scenes.at(-1)
    if (current === undefined) return
    current.segments = splitPrompt(body.join('\n').trim())
    current.frameNumbers = [
      ...new Set(
        current.segments.flatMap((segment) => (segment.kind === 'frame' ? [segment.number] : [])),
      ),
    ]
  }

  for (const [line, text] of shot.prompt.split('\n').entries()) {
    const header = SCENE_HEADER.exec(text)
    if (header === null) {
      if (scenes.length === 0) preamble.push(text)
      else body.push(text)
      continue
    }
    flush()
    body = []
    scenes.push({
      endSeconds: Number(header[2]),
      frameNumbers: [],
      id: `s${line}`,
      scene: Number(header[3]),
      segments: [],
      startSeconds: Number(header[1]),
    })
  }
  flush()

  return { preamble: preamble.join('\n').trim(), scenes }
}

export const sceneOfFrame = (timeline: ShotTimeline, frameNumber: number): ShotScene | undefined =>
  timeline.scenes.find((scene) => scene.frameNumbers.includes(frameNumber))

/** 优先取第一镜正文，避免参考锁定等通用前言成为所有组的名称。 */
export const shotName = (shot: Shot): string => {
  const timeline = splitShotTimeline(shot)
  const source =
    timeline.scenes[0] === undefined
      ? timeline.preamble
      : timeline.scenes[0].segments
          .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
          .join('')
  const firstLine = source
    .split('\n')
    // 移除帧记号后清理标点前残留空格。
    .map((line) =>
      line
        .replace(FRAME_REF, '')
        .replace(/\s+([，。；！？、,.;!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .find((line) => line.length > 0)
  if (firstLine === undefined || firstLine.length === 0) return `镜头组 ${shot.index}`
  const sentence = firstLine.split(SENTENCE_END)[0]?.trim() ?? ''
  return sentence.length === 0 ? firstLine : sentence
}

export const firstFrameOfScene = (scene: ShotScene): number | undefined => scene.frameNumbers[0]

export const shotSelectionRef = (index: number, frame?: number): WorkbenchRef =>
  frame === undefined
    ? { id: `shot:${index}`, label: `镜头组 ${index}`, prefix: `针对镜头组 ${index}：` }
    : {
        id: `shot:${index}:frame:${frame}`,
        label: `镜头组 ${index} · 帧 @${frame}`,
        prefix: `针对镜头组 ${index} 的帧 @${frame}：`,
      }

export interface ShotGeneration {
  createdAt: string
  kind: string
  outputUrl: string | null
  shotIndex: number | null
  status: string
}

const IN_FLIGHT = new Set(['pending', 'submitting', 'submitted'])

export const isRunningStatus = (status: string): boolean => IN_FLIGHT.has(status)

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

export const runningShots = (jobs: readonly ShotGeneration[]): Set<number> =>
  new Set(
    jobs.flatMap((job) =>
      job.kind === 'video' && job.shotIndex !== null && isRunningStatus(job.status)
        ? [job.shotIndex]
        : [],
    ),
  )

export type ShotStatus = 'ready' | 'running' | 'idle'

/** 已有成片优先于生成中状态，便于识别可观看内容。 */
export const shotStatus = (
  index: number,
  videos: ReadonlyMap<number, string>,
  running: ReadonlySet<number>,
): ShotStatus => {
  if (videos.has(index)) return 'ready'
  return running.has(index) ? 'running' : 'idle'
}
